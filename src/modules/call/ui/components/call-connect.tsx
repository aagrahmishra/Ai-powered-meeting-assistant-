"use client";

import { LoaderIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  Call,
  CallingState,
  StreamCall,
  StreamVideo,
  StreamVideoClient,
} from "@stream-io/video-react-sdk";

import { useTRPC } from "@/trpc/client";

import "@stream-io/video-react-sdk/dist/css/styles.css";
import { CallUI } from "./call-ui";

interface Props {
  meetingId: string;
  meetingName: string;
  userId: string;
  userName: string;
  userImage: string;
};

export const CallConnect = ({
  meetingId,
  meetingName,
  userId,
  userName,
  userImage,
}: Props) => {
  const trpc = useTRPC();
  const generateTokenOptions = useMemo(
    () => trpc.meetings.generateToken.mutationOptions(),
    [trpc],
  );
  const { mutateAsync: mutateAsyncGenerateToken } = useMutation(
    generateTokenOptions,
  );

  // Memoize the token provider to avoid recreating the client on every render
  const generateToken = useCallback(mutateAsyncGenerateToken, [mutateAsyncGenerateToken]);

  const [client, setClient] = useState<StreamVideoClient>();
  useEffect(() => {
    const _client = new StreamVideoClient({
      apiKey: process.env.NEXT_PUBLIC_STREAM_VIDEO_API_KEY!,
      user: {
        id: userId,
        name: userName,
        image: userImage,
      },
      tokenProvider: generateToken,
    });

    setClient(_client);

    return () => {
      _client.disconnectUser();
      setClient(undefined);
    };
  }, [userId, userName, userImage, generateToken]);

  const [call, setCall] = useState<Call>();
  const [joinError, setJoinError] = useState<string | null>(null);

  useEffect(() => {
      if (!client) return;

      const _call = client.call("default", meetingId);
      
      // Join the call
      _call.join({ create: true }).catch((error) => {
        console.error("Failed to join call:", error);
        setJoinError(error instanceof Error ? error.message : "Failed to join call");
      });

      // Enable camera and microphone after joining
      _call.camera.enable();
      _call.microphone.enable();
      
      setCall(_call);

      return () => {
        if (_call.state.callingState !== CallingState.LEFT) {
          _call.leave();
          _call.endCall();
          setCall(undefined);
        }
      };
  }, [client, meetingId]);

  if (joinError) {
    return (
      <div className="flex h-screen items-center justify-center bg-radial from-sidebar-accent to-sidebar">
        <div className="text-center">
          <h2 className="text-xl font-semibold text-white mb-2">Failed to Join Call</h2>
          <p className="text-red-400">{joinError}</p>
        </div>
      </div>
    );
  }

  if (!client || !call) {
    return (
      <div className="flex h-screen items-center justify-center bg-radial from-sidebar-accent to-sidebar">
        <LoaderIcon className="size-6 animate-spin text-white" />
      </div>
    );
  }

  return (
    <StreamVideo client={client}>
      <StreamCall call={call}>
        <CallUI meetingName={meetingName} />
      </StreamCall>
    </StreamVideo>
  );
};
