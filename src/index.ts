import {mkdir, readFile, rm, writeFile} from 'fs/promises';
import * as path from 'path';
import axios from "axios";
import OpenAI from "openai";
import {spawn} from "child_process";
import {ElevenLabsClient} from "elevenlabs";
import {renderVideo} from "@revideo/renderer";
import dotenv from 'dotenv';
import express from "express";

dotenv.config();

const openAIClient = new OpenAI({apiKey: process.env.OPENAI_API_KEY });
const elevenLabsClient = new ElevenLabsClient({ apiKey: process.env.ELEVENLABS_API_KEY });
const PEXELS_API = process.env.PEXELS_API_KEY
const SUBTITLES = process.env.SUBTITLES == "TRUE"

// Function to query Pexels API for video footage
async function queryPexels(query: string): Promise<Video> {
    try {
        const response = await axios.get(
            `https://api.pexels.com/videos/search?query=${encodeURIComponent(query)}`,
            {
                headers: {
                    'User-Agent': 'curl/7.81.0',
                    Authorization: PEXELS_API,
                },
            }
        );

        const videos = response.data.videos[0].video_files;
        let bestVideo = null;

        for (const video of videos) {
            if (
                !bestVideo ||
                bestVideo.width * bestVideo.height < video.width * video.height
            ) {
                bestVideo = video;
            }
        }

        return {
            width: bestVideo.width,
            height: bestVideo.height,
            quality: bestVideo.quality,
            fps: bestVideo.fps,
            link: bestVideo.link,
        };
    } catch (error) {
        console.error('Error querying Pexels:', error);
        process.exit(1)
    }
}

// Function to clean JSON string from code blocks
function cleanJsonString(jsonString: string | null) {
    if(!jsonString) {
        return;
    }

    const pattern = /^```json\s*(.*?)\s*```$/s;
    const match = jsonString.match(pattern);
    if (match) {
        return match[1].trim();
    }
    return jsonString.trim();
}

// Function to encode video using ffmpeg
function encodeVideo(data: Script, videoSources: string[], audioSource: string): Promise<string> {
    console.log('Encoding video...');
    const output = path.resolve('out/video.mp4');
    const command = [];

    videoSources.forEach((_, index) => {
        command.push('-i', `out/clips/${index + 1}.mp4`);
    });

    command.push('-i', audioSource);

    let filters = '';
    let streams = '';

    videoSources.forEach((_, index) => {
        const end = Math.ceil(data.visuals[index].end!);
        const duration =
            index === 0
                ? end
                : end - Math.ceil(data.visuals[index - 1].end!);
        filters += `[${index}:v]trim=duration=${duration},scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,setsar=1,setpts=PTS-STARTPTS[v${index}];`;
        streams += `[v${index}]`;
    });

    filters += `${streams}concat=n=${videoSources.length}:v=1:a=0[concatv]`;
    command.push('-filter_complex', filters);

    command.push('-map', '[concatv]');
    command.push('-map', `${videoSources.length}:a`);

    command.push(output);

    const ffmpeg = spawn("ffmpeg", command);

    return new Promise((resolve, reject) => {
        ffmpeg.on('close', (code) => {
            if (code === 0) {
                resolve(output);
            } else {
                reject(new Error(`Failed to encode video: ${code}`));
            }
        });
    });
}

// Function to clean previous output
async function clean() {
    console.log('Clearing previous output...');
    const outDir = 'out';
    await rm(outDir, {recursive: true, force: true})
    await mkdir(outDir, { recursive: true });
}

// Function to create script using OpenAI API
async function createScript(): Promise<Script> {
    console.log('Reading article...');
    let article;
    try {
        article = await readFile('article.txt', {
            encoding: 'utf8'
        });
    } catch (err) {
        console.error('Error reading article.txt:', err);
        process.exit(1)
    }

    console.log('Generating script...');
    try {
        const completion = await openAIClient.chat.completions.create({
            model: 'gpt-4o',
            messages: [
                {
                    role: 'system',
                    content: `
Generate a JSON object that follows this specification:
- tone:
  generate a JSON array of two strings consisting of the two adjectives most related to the article's tone.
- script:
  generate using the input article a video script that can be read in one minute. Make the script engaging and interesting, use a journalist's tone, don't be formal, don't greet the reader, don't go to the new line.
- visuals:
  generate a list of JSON objects that follow this specification:
    - description:
      generate descriptions for possible background video footage that should be used while narrating the script, from start to finish, for each sentence in the script.
      Each description is made up of approximately three keywords. Prefer simpler keywords to complicated or technical ones, prefer explaining general concepts to specific people doing things, remain general.
    - source:
      the sentence that was used to generate the list of descriptions.
          `,
                },
                {
                    role: 'user',
                    content: article,
                },
            ],
        });

        const result = cleanJsonString(completion.choices[0].message.content);
        if(!result) {
            console.error('Error parsing JSON: no result');
            process.exit(1)
        }

        await writeFile('out/source.json', result);
        return JSON.parse(result);
    } catch (error) {
        console.error('Error generating script:', error);
        process.exit(1)
    }
}

// Function to generate clips data
async function generateClipsData(result: Script) {
    console.log('Searching b-roll footage...');
    for (const section of result.visuals) {
        section.video = await queryPexels(section.description);
    }

    const clipFiles = [];
    await mkdir('out/clips', { recursive: true });
    let counter = 0;

    for (const section of result.visuals) {
        counter += 1;
        const clipPath = `out/clips/${counter}.mp4`;
        const link = section.video!.link;
        console.log(`Downloading ${link}`);
        const response = await axios.get(link, {
            responseType: 'arraybuffer',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
            },
        });
        await writeFile(clipPath, response.data);
        clipFiles.push(clipPath);
    }

    await writeFile('out/source.json', JSON.stringify(result, null, 2));
    return clipFiles;
}

// Function to generate audio data using ElevenLabs API
async function generateAudioData(result: Script): Promise<AudioData> {
    console.log('Generating voice...');
    try {
        const voicesResponse = await elevenLabsClient.voices.getAll();
        const voiceIndex = Math.floor(Math.random() * voicesResponse.voices.length);
        const voice = voicesResponse.voices[voiceIndex];
        result.voiceName = voice.name;
        await writeFile('out/source.json', JSON.stringify(result, null, 2));
        return await elevenLabsClient.textToSpeech.convertWithTimestamps(voice.voice_id, {
            text: result.script
        }) as AudioData;
    } catch (error) {
        console.error('Error generating audio data:', error);
        process.exit(-1)
    }
}

// Function to save audio file
async function saveAudio(audioData: AudioData) {
    console.log('Saving audio...');
    const audioFile = 'out/voice.mp3';
    await writeFile(audioFile, Buffer.from(audioData.audio_base64, 'base64'));
    return audioFile;
}

// Function to compute clips duration
async function computeClipsDuration(result: Script, audioData: AudioData) {
    console.log('Mapping audio to clips...');

    let counter = 0;
    const characters = audioData.alignment.characters
    const ends = audioData.alignment.character_end_times_seconds
    for(let index = 0; index < characters.length; index++) {
        const character = characters[index];
        if(character == "." || character == '?' || character == '!') {
            result.visuals[counter].end = ends[index];
            counter++;
            if(counter == result.visuals.length) {
                break
            }
        }
    }
    result.visuals[result.visuals.length - 1].end = ends[ends.length - 1];
    await writeFile('out/source.json', JSON.stringify(result, null, 2));
}

async function addSubtitles(video: string, audioData: AudioData) {
    if(SUBTITLES) {
        console.log('Adding subtitles...');

        await startHttpService();

        const words: Word[] = [];
        let currentWord = "";
        let previousStart = 0;
        for (let i = 0; i < audioData.alignment.characters.length; i++){
            const char = audioData.alignment.characters[i];
            if (char != " ") {
                currentWord += char;
            }

            if(char == " " || char == "." || char == "?" || char == "!") {
                let currentStart = audioData.alignment.character_end_times_seconds[i];
                words.push({
                    punctuated_word: currentWord,
                    start: previousStart,
                    end: currentStart
                });
                previousStart = currentStart;
            }
        }

        return await renderVideo({
            projectFile: './src/subtitles/subtitles.tsx',
            variables: {
                video: "http://localhost:8080/video.mp4",
                words: words
            },
            settings: {
                logProgress: true,
                puppeteer: {
                    args: [
                        "--disable-web-security"
                    ]
                }
            },
        });
    }
}

// Starts a http service to serve the video to chromium
function startHttpService(): Promise<undefined> {
    return new Promise((resolve, reject) => {
        try {
            const app = express();
            const port = 8080;
            app.use(express.static('out'));
            app.listen(port, () => {
                console.log(`Video server is running at http://localhost:${port}`);
                resolve(undefined);
            });
        }catch (error) {
            reject(error);
        }
    });
}

// Function to generate the video from article.txt
async function generateVideo() {
    await clean();
    const result = await createScript();
    const clips = await generateClipsData(result);
    const audio = await generateAudioData(result);
    const audioFile = await saveAudio(audio);
    await computeClipsDuration(result, audio);
    const videoPath = await encodeVideo(result, clips, audioFile);
    const videoWithSubtitlesPath = await addSubtitles(videoPath, audio);
    console.log(`Saved video at: ${videoWithSubtitlesPath}`);
}

await generateVideo()