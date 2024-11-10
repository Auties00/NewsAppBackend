interface Word {
    punctuated_word: string;
    start: number;
    end: number;
}

interface CaptionSettings {
    fontSize: number;
    textColor: string;
    fontWeight: number;
    fontFamily: string;
    numSimultaneousWords: number;
    stream: boolean;
    textAlign: "center" | "left";
    textBoxWidthInPercent: number;
    borderColor?: string;
    borderWidth?: number;
    currentWordColor: string;
    currentWordBackgroundColor: string;
    shadowColor?: string;
    shadowBlur?: number;
    fadeInAnimation?: boolean;
}