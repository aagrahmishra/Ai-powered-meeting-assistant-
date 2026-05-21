import { useMemo } from "react";
import { useCallStateHooks } from "@stream-io/video-react-sdk";

export interface TranscriptItem {
  text: string;
  speaker: string;
  timestamp: number;
  finalized: boolean;
}

const MAX_TRANSCRIPT_ITEMS = 30;

export function useRealtimeTranscript(): {
  transcript: TranscriptItem[];
  latestTranscript: TranscriptItem | null;
} {
  // useCallClosedCaptions is the Stream SDK hook that provides live closed captions
  // (equivalent to useCallStateHooks().useCaptions() in concept)
  const { useCallClosedCaptions } = useCallStateHooks();
  const closedCaptions = useCallClosedCaptions();

  const transcript = useMemo<TranscriptItem[]>(() => {
    if (!closedCaptions || closedCaptions.length === 0) return [];

    const seen = new Set<string>();
    const normalized: TranscriptItem[] = [];

    for (const caption of closedCaptions) {
      // Deduplicate using speaker id + start_time as a composite key
      const key = `${caption.user.id}-${caption.start_time}`;
      if (seen.has(key)) continue;
      seen.add(key);

      normalized.push({
        text: caption.text,
        speaker: caption.user.name ?? caption.user.id,
        timestamp: new Date(caption.start_time).getTime(),
        // useCallClosedCaptions only returns completed captions, so all items are finalized
        finalized: true,
      });
    }

    // Sort ascending by timestamp and keep only the last 30 items
    return normalized
      .sort((a, b) => a.timestamp - b.timestamp)
      .slice(-MAX_TRANSCRIPT_ITEMS);
  }, [closedCaptions]);

  const latestTranscript = transcript.length > 0
    ? transcript[transcript.length - 1]
    : null;

  return { transcript, latestTranscript };
}
