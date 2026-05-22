import Link from "next/link";
import Image from "next/image";
import { useMemo, useState } from "react";
import {
  CallControls,
  SpeakerLayout,
} from "@stream-io/video-react-sdk";

import { useRealtimeTranscript } from "@/hooks/use-realtime-transcript";

interface Props {
  onLeave: () => void;
  meetingName: string;
};

const VISIBLE_CAPTION_COUNT = 3;

export const CallActive = ({ onLeave, meetingName }: Props) => {
  const { transcript } = useRealtimeTranscript();
  const [renderError, setRenderError] = useState<string | null>(null);

  const visibleCaptions = useMemo(
    () => transcript.slice(-VISIBLE_CAPTION_COUNT),
    [transcript],
  );

  const handleVideoError = (error: Error) => {
    console.error("Video rendering error:", error);
    setRenderError(error.message || "Failed to render video stream");
  };

  return (
    <div className="relative flex flex-col justify-between p-4 h-full text-white">
      <div className="bg-[#101213] rounded-full p-4 flex items-center gap-4">
        <Link href="/" className="flex items-center justify-center p-1 bg-white/10 rounded-full w-fit">
          <Image src="/logo.svg" width={22} height={22} alt="Logo" />
        </Link>
        <h4 className="text-base">
          {meetingName}
        </h4>
      </div>
      
      {renderError ? (
        <div 
          className="flex-1 flex items-center justify-center bg-black/50 rounded-lg"
          aria-label="Video error display"
        >
          <div className="text-center">
            <p className="text-lg text-red-400 mb-2">⚠️ Video Stream Error</p>
            <p className="text-sm text-white/60">{renderError}</p>
            <p className="text-xs text-white/40 mt-2">Please try reconnecting</p>
          </div>
        </div>
      ) : (
        <div onError={() => handleVideoError(new Error("SpeakerLayout rendering failed"))}>
          <SpeakerLayout />
        </div>
      )}
      
      {visibleCaptions.length > 0 && (
        <div className="absolute bottom-20 left-0 right-0 flex justify-center px-6 pointer-events-none">
          <div className="bg-black/75 rounded-xl px-5 py-3 max-w-2xl w-full space-y-1">
            {visibleCaptions.map((item, index) => (
              <p
                key={index}
                className="text-sm leading-relaxed"
              >
                <span className="font-semibold text-white/60 mr-1">
                  {item.speaker}:
                </span>
                <span className="text-white">{item.text}</span>
              </p>
            ))}
          </div>
        </div>
      )}
      
      <div className="bg-[#101213] rounded-full px-4">
        <CallControls onLeave={onLeave} />
      </div>
    </div>
  );
};
