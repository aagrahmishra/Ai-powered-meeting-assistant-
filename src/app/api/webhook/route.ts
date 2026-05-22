import OpenAI from "openai";
import { and, eq, not } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { ChatCompletionMessageParam } from "openai/resources/index.mjs";
import {
  MessageNewEvent,
  CallEndedEvent,
  CallTranscriptionReadyEvent,
  CallRecordingReadyEvent,
  CallSessionParticipantLeftEvent,
  CallSessionStartedEvent,
} from "@stream-io/node-sdk";
import { db } from "@/db";
import { agents, meetings } from "@/db/schema";
import { streamVideo } from "@/lib/stream-video";
import { inngest } from "@/inngest/client";
import { generateAvatarUri } from "@/lib/avatar";
import { streamChat } from "@/lib/stream-chat";

type AgentRealtimeClient = {
  disconnect: () => void;
  on: (eventName: "error", handler: (error: unknown) => void) => void;
  updateSession: (sessionConfig: { instructions?: string }) => unknown;
};

const openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });
const globalForAgentConnections = globalThis as typeof globalThis & {
  activeAgentConnections?: Map<string, AgentRealtimeClient>;
  connectingMeetings?: Set<string>;
};

const activeAgentConnections =
  globalForAgentConnections.activeAgentConnections ??
  new Map<string, AgentRealtimeClient>();

globalForAgentConnections.activeAgentConnections = activeAgentConnections;

// Track meetings currently being connected to prevent race conditions
const connectingMeetings =
  globalForAgentConnections.connectingMeetings ??
  new Set<string>();

globalForAgentConnections.connectingMeetings = connectingMeetings;

export const runtime = "nodejs";

function verifySignatureWithSDK(body: string, signature: string): boolean {
  return streamVideo.verifyWebhook(body, signature);
}

function disconnectAgentConnection(meetingId: string) {
  const agentConnection = activeAgentConnections.get(meetingId);

  if (!agentConnection) {
    return;
  }

  agentConnection.disconnect();
  activeAgentConnections.delete(meetingId);
}

export async function POST(req: NextRequest) {
  const signature = req.headers.get("x-signature");
  const apiKey = req.headers.get("x-api-key");

  if (!signature || !apiKey) {
    return NextResponse.json(
      { error: "Missing signature or API key" },
      { status: 400 }
    );
  }

  const body = await req.text();

  if (!verifySignatureWithSDK(body, signature)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(body) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const eventType = (payload as Record<string, unknown>)?.type;

  if (eventType === "call.session_started") {
    const event = payload as CallSessionStartedEvent;
    const meetingId = event.call.custom?.meetingId;

    console.log(`[Agent Join] Received session_started for meetingId: ${meetingId}`);

    if (!meetingId) {
      return NextResponse.json({ error: "Missing meetingId" }, { status: 400 });
    }

    // Early return if agent is already connected or being connected for this meeting
    if (activeAgentConnections.has(meetingId) || connectingMeetings.has(meetingId)) {
      console.log(`[Agent Join] Agent already connected/connecting for meeting ${meetingId}, ignoring duplicate`);
      return NextResponse.json({ status: "already_connected" });
    }

    // Mark this meeting as being connected to prevent concurrent connection attempts
    connectingMeetings.add(meetingId);

    const [existingMeeting] = await db
      .select()
      .from(meetings)
      .where(eq(meetings.id, meetingId));

    if (!existingMeeting) {
      console.error(`[Agent Join] Meeting not found: ${meetingId}`);
      return NextResponse.json({ error: "Meeting not found" }, { status: 404 });
    }

    console.log(`[Agent Join] Meeting found with status: ${existingMeeting.status}`);

    if (existingMeeting.status === "completed" || existingMeeting.status === "cancelled") {
      console.log(`[Agent Join] Meeting is ${existingMeeting.status}, ignoring session_started`);
      return NextResponse.json({ status: "ignored" });
    }

    console.log(`[Agent Join] Updating meeting status to active`);
    const updatedMeetings = await db
      .update(meetings)
      .set({
        status: "active",
        startedAt: new Date(),
      })
      .where(
        and(
          eq(meetings.id, existingMeeting.id),
          not(eq(meetings.status, "active"))
        )
      )
      .returning();

    const meeting = updatedMeetings[0] ?? existingMeeting;
    console.log(`[Agent Join] Meeting status updated, agentId: ${meeting.agentId}`);

    const [existingAgent] = await db
      .select()
      .from(agents)
      .where(eq(agents.id, meeting.agentId));

    if (!existingAgent) {
      console.error(`[Agent Join] Agent not found: ${meeting.agentId}`);
      return NextResponse.json({ error: "Agent not found" }, { status: 404 });
    }

    console.log(`[Agent Join] Agent found: ${existingAgent.name} (${existingAgent.id})`);

    const avatarUrl = generateAvatarUri({
      seed: existingAgent.name,
      variant: "botttsNeutral",
    });

    console.log(`[Agent Join] Upserting agent user to Stream`);
    await streamVideo.upsertUsers([{
      id: existingAgent.id,
      name: existingAgent.name,
      role: "admin",
      image: avatarUrl,
    }]);

    console.log(`[Agent Join] Generating agent token`);
    const agentToken = streamVideo.generateUserToken({
      user_id: existingAgent.id,
      validity_in_seconds: 3600, // 1 hour
    });
    console.log(`[Agent Join] Agent token generated: ${agentToken.substring(0, 20)}...`);

    const call = streamVideo.video.call("default", meetingId);

    console.log(`[Agent Join] Fetching call object for meeting ${meetingId}`);
    await call.get();

    console.log(`[Agent Join] Adding agent as call member`);
    await call.updateCallMembers({
      update_members: [{
        user_id: existingAgent.id,
        role: "admin",
      }],
    });

    try {
      console.log(`[Agent Join] Connecting OpenAI Realtime for agent ${existingAgent.id}`);
      
      const realtimeClient = await streamVideo.video.connectOpenAi({
        call,
        openAiApiKey: process.env.OPENAI_API_KEY!,
        agentUserId: existingAgent.id,
        model: "gpt-4o-realtime-preview",
        validityInSeconds: 3600, // 1 hour
      });
      
      if (!realtimeClient) {
        throw new Error("connectOpenAi returned null/undefined client");
      }

      console.log(`[Agent Join] OpenAI Realtime client created successfully`);

      activeAgentConnections.set(meetingId, realtimeClient);

      console.log(`[Agent Join] Updating session with instructions`);
      realtimeClient.updateSession({
        instructions: existingAgent.instructions,
      });

      realtimeClient.on("error", (error: unknown) => {
        console.error(`[Agent Join] OpenAI Realtime error for meeting ${meetingId}:`, error);
        disconnectAgentConnection(meetingId);
      });

      console.log(`[Agent Join] Agent setup complete for meeting ${meetingId}`);
      connectingMeetings.delete(meetingId);
    } catch (error) {
      console.error(`[Agent Join] Failed to connect agent for meeting ${meetingId}:`, {
        error,
        message: error instanceof Error ? error.message : String(error),
      });
      connectingMeetings.delete(meetingId);
      disconnectAgentConnection(meetingId);
      return NextResponse.json(
        { error: "Failed to connect agent", details: error instanceof Error ? error.message : String(error) },
        { status: 500 }
      );
    }

    return NextResponse.json({ status: "ok" });

  } else if (eventType === "call.session_participant_left") {
    const event = payload as CallSessionParticipantLeftEvent;
    const meetingId = event.call_cid.split(":")[1];

    if (!meetingId) {
      return NextResponse.json({ error: "Missing meetingId" }, { status: 400 });
    }

    const participantUserId = event.participant?.user?.id;

    const agentList = participantUserId
      ? await db.select().from(agents).where(eq(agents.id, participantUserId))
      : [];

    const isAgent = agentList.length > 0;

    if (!isAgent) {
      disconnectAgentConnection(meetingId);
      const call = streamVideo.video.call("default", meetingId);
      await call.end();
    } else {
      disconnectAgentConnection(meetingId);
      console.log("Agent left the call, not ending the call.");
    }

  } else if (eventType === "call.session_ended") {
    const event = payload as CallEndedEvent;
    const meetingId = event.call.custom?.meetingId;

    if (!meetingId) {
      return NextResponse.json({ error: "Missing meetingId" }, { status: 400 });
    }

    await db
      .update(meetings)
      .set({
        status: "processing",
        endedAt: new Date(),
      })
      .where(and(eq(meetings.id, meetingId), eq(meetings.status, "active")));

    disconnectAgentConnection(meetingId);

  } else if (eventType === "call.transcription_ready") {
    const event = payload as CallTranscriptionReadyEvent;
    const meetingId = event.call_cid.split(":")[1];

    const [updatedMeeting] = await db
      .update(meetings)
      .set({
        transcriptUrl: event.call_transcription.url,
      })
      .where(eq(meetings.id, meetingId))
      .returning();

    if (!updatedMeeting) {
      return NextResponse.json({ error: "Meeting not found" }, { status: 404 });
    }

    await inngest.send({
      name: "meetings/processing",
      data: {
        meetingId: updatedMeeting.id,
        transcriptUrl: updatedMeeting.transcriptUrl,
      },
    });

  } else if (eventType === "call.recording_ready") {
    const event = payload as CallRecordingReadyEvent;
    const meetingId = event.call_cid.split(":")[1];

    await db
      .update(meetings)
      .set({
        recordingUrl: event.call_recording.url,
      })
      .where(eq(meetings.id, meetingId));

  } else if (eventType === "message.new") {
    const event = payload as MessageNewEvent;
    const userId = event.user?.id;
    const channelId = event.channel_id;
    const text = event.message?.text;

    if (!userId || !channelId || !text) {
      return NextResponse.json(
        { error: "Missing required fields" },
        { status: 400 }
      );
    }

    const [existingMeeting] = await db
      .select()
      .from(meetings)
      .where(and(eq(meetings.id, channelId), eq(meetings.status, "completed")));

    if (!existingMeeting) {
      return NextResponse.json({ error: "Meeting not found" }, { status: 404 });
    }

    const [existingAgent] = await db
      .select()
      .from(agents)
      .where(eq(agents.id, existingMeeting.agentId));

    if (!existingAgent) {
      return NextResponse.json({ error: "Agent not found" }, { status: 404 });
    }

    if (userId !== existingAgent.id) {
      const instructions = `
      You are an AI assistant helping the user revisit a recently completed meeting.
      Below is a summary of the meeting, generated from the transcript:
      
      ${existingMeeting.summary}
      
      The following are your original instructions from the live meeting assistant. Please continue to follow these behavioral guidelines as you assist the user:
      
      ${existingAgent.instructions}
      
      The user may ask questions about the meeting, request clarifications, or ask for follow-up actions.
      Always base your responses on the meeting summary above.
      
      If the summary does not contain enough information to answer a question, politely let the user know.
      
      Be concise, helpful, and focus on providing accurate information from the meeting and the ongoing conversation.
      `;

      const channel = streamChat.channel("messaging", channelId);
      await channel.watch();

      const previousMessages = channel.state.messages
        .slice(-5)
        .filter((msg) => msg.text && msg.text.trim() !== "")
        .map<ChatCompletionMessageParam>((message) => ({
          role: message.user?.id === existingAgent.id ? "assistant" : "user",
          content: message.text || "",
        }));

      const GPTResponse = await openaiClient.chat.completions.create({
        messages: [
          { role: "system", content: instructions },
          ...previousMessages,
          { role: "user", content: text },
        ],
        model: "gpt-4o",
      });

      const GPTResponseText = GPTResponse.choices[0].message.content;

      if (!GPTResponseText) {
        return NextResponse.json(
          { error: "No response from GPT" },
          { status: 400 }
        );
      }

      const agentAvatarUrl = generateAvatarUri({
        seed: existingAgent.name,
        variant: "botttsNeutral",
      });

      streamChat.upsertUser({
        id: existingAgent.id,
        name: existingAgent.name,
        image: agentAvatarUrl,
      });

      channel.sendMessage({
        text: GPTResponseText,
        user: {
          id: existingAgent.id,
          name: existingAgent.name,
          image: agentAvatarUrl,
        },
      });
    }
  }

  return NextResponse.json({ status: "ok" });
}
