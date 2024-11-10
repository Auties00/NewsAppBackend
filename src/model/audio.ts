interface AudioData {
    audio_base64: string;
    alignment: AudioAlignment;
    normalized_alignment: AudioAlignment;
}

interface AudioAlignment {
    characters: string[];
    character_end_times_seconds: number[];
}