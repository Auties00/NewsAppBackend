interface Script {
    voiceName: string | undefined;
    tone: [string];
    script: string;
    visuals: [Visual];
}

interface Visual {
    description: string;
    source: string;
    video: Video | undefined;
    end: number | undefined;
}

interface Video {
    width: number;
    height: number;
    quality: number;
    fps: number;
    link: string;
}