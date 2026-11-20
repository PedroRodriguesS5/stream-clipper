import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import axios from 'axios';
import { config } from '../utils/config.js';
import { log } from '../utils/logger.js';

const execFileAsync = promisify(execFile);

let cached9RouterKey: string | null = null;
let claudeCliExhaustedUntil = 0;

/**
 * Resolves a working 9Router API key from env/config or `~/.9router/db/data.sqlite`.
 */
export const resolve9RouterApiKey = async (): Promise<string> => {
  if (
    config.nineRouterApiKey &&
    config.nineRouterApiKey !== 'local-9router' &&
    config.nineRouterApiKey !== 'dummy'
  ) {
    return config.nineRouterApiKey;
  }
  if (cached9RouterKey) return cached9RouterKey;

  try {
    const dbPath = path.join(os.homedir(), '.9router', 'db', 'data.sqlite');
    const { stdout } = await execFileAsync('sqlite3', [dbPath, 'SELECT key FROM apiKeys LIMIT 1;'], {
      timeout: 5000,
    });
    const key = stdout.trim();
    if (key) {
      cached9RouterKey = key;
      return key;
    }
  } catch {
    // ignore sqlite lookup failure
  }
  return config.nineRouterApiKey || 'local-9router';
};

/**
 * Extracts text from a 9Router response payload (handles both JSON and SSE `data: {...}` streams).
 */
export const extractTextFrom9RouterPayload = (payload: unknown): string => {
  if (typeof payload === 'string') {
    const lines = payload.split(/\r?\n/);
    let assembled = '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const dataStr = trimmed.slice(5).trim();
      if (!dataStr || dataStr === '[DONE]') continue;
      try {
        const chunk = JSON.parse(dataStr);
        const delta = chunk?.choices?.[0]?.delta;
        if (typeof delta?.content === 'string') {
          assembled += delta.content;
        } else if (typeof chunk?.choices?.[0]?.message?.content === 'string') {
          assembled += chunk.choices[0].message.content;
        }
      } catch {
        // ignore non-json SSE line
      }
    }
    if (assembled.trim()) return assembled.trim();

    // Non-SSE JSON string (standard OpenAI chat.completion envelope)
    try {
      const parsedObj = JSON.parse(payload.trim());
      if (parsedObj && typeof parsedObj === 'object') {
        const msg = parsedObj?.choices?.[0]?.message;
        const toolArgs = msg?.tool_calls?.[0]?.function?.arguments;
        if (typeof toolArgs === 'string' && toolArgs.trim()) return toolArgs.trim();
        if (typeof msg?.content === 'string' && msg.content.trim()) return msg.content.trim();
        if (parsedObj?.error) {
          throw new Error(`9Router error: ${JSON.stringify(parsedObj.error)}`);
        }
      }
    } catch (e) {
      if ((e as Error).message.startsWith('9Router error:')) throw e;
    }

    return payload.trim();
  }

  if (payload && typeof payload === 'object') {
    const obj = payload as Record<string, any>;
    const msg = obj?.choices?.[0]?.message;
    const toolArgs = msg?.tool_calls?.[0]?.function?.arguments;
    if (typeof toolArgs === 'string' && toolArgs.trim()) return toolArgs.trim();
    if (typeof msg?.content === 'string' && msg.content.trim()) return msg.content.trim();
  }

  return '';
};

const extractImagePathsFromPrompt = async (prompt: string): Promise<string[]> => {
  const regex = /(\/[^\s"',;)]+\.(?:jpg|jpeg|png|webp))/gi;
  const matches = prompt.match(regex) || [];
  const unique = [...new Set(matches)];
  const existing: string[] = [];
  for (const p of unique.slice(0, 14)) {
    try {
      await fs.access(p);
      existing.push(p);
    } catch {
      // ignore missing file
    }
  }
  return existing;
};

const parseJsonFromText = <T>(rawText: string): T => {
  const cleaned = rawText
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      return JSON.parse(match[0]) as T;
    }
    throw new Error(`Response did not contain valid JSON: ${rawText.slice(0, 240)}`);
  }
};

/**
 * Verified vision-capable models in 9Router that inspect `image_url` base64 frames accurately.
 * (Models like `ag/claude-*` strip `image_url`, and `gh/gpt-4o(-mini)` reject base64 media types.)
 */
const VISION_MODEL_CHAIN = [
  'ag/gemini-4-argon-medium',
  'ag/gemini-3.8-flash-high',
  'ag/gemini-4-argon-high',
  'ag/gemini-3.8-flash-medium',
  'gh/gpt-4.1',
];

const TEXT_MODEL_CHAIN = [
  'ag/gemini-3.8-flash-high',
  'ag/gemini-4-argon-medium',
  'gh/gpt-4.1',
  'code',
];

/**
 * Calls local 9Router (`http://localhost:20128/v1/chat/completions`) with optional vision frames
 * and parses the returned JSON matching `schema`.
 */
export const run9RouterJson = async <T>(
  prompt: string,
  schema: object,
  options: { tools?: string[]; timeoutMs?: number } = {}
): Promise<T> => {
  const apiKey = await resolve9RouterApiKey();
  const wantsRead = (options.tools ?? []).includes('Read');
  const imagePaths = wantsRead ? await extractImagePathsFromPrompt(prompt) : [];

  const systemInstruction = [
    'You are a precise structured-output assistant.',
    'Respond ONLY with a single valid JSON object matching this JSON Schema (no markdown fences, no commentary):',
    JSON.stringify(schema),
  ].join('\n');

  let userContent: any = prompt;
  if (imagePaths.length > 0) {
    const parts: any[] = [{ type: 'text', text: prompt }];
    for (const imgPath of imagePaths) {
      try {
        const buf = await fs.readFile(imgPath);
        const ext = path.extname(imgPath).toLowerCase();
        const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
        const secMatch = path.basename(imgPath).match(/_(\d+)s\./);
        const label = secMatch ? `[Frame at second ${secMatch[1]}s (${path.basename(imgPath)})]` : `[Image: ${path.basename(imgPath)}]`;
        parts.push({ type: 'text', text: label });
        parts.push({
          type: 'image_url',
          image_url: {
            url: `data:${mime};base64,${buf.toString('base64')}`,
          },
        });
      } catch {
        // skip unreadable image
      }
    }
    userContent = parts;
  }

  const candidateModels = imagePaths.length > 0 ? VISION_MODEL_CHAIN : TEXT_MODEL_CHAIN;
  let lastErr: Error | null = null;

  for (const model of candidateModels) {
    try {
      const response = await axios.post(
        config.nineRouterEndpoint,
        {
          model,
          messages: [
            { role: 'system', content: systemInstruction },
            { role: 'user', content: userContent },
          ],
          temperature: 0.15,
        },
        {
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          timeout: Math.min(options.timeoutMs ?? 90_000, 65_000),
          responseType: 'text',
        }
      );

      const rawText = extractTextFrom9RouterPayload(response.data);
      if (!rawText) {
        throw new Error(`Model ${model} returned an empty response`);
      }
      return parseJsonFromText<T>(rawText);
    } catch (err) {
      lastErr = err as Error;
      log('WARN', 'AI-Router', `9Router model ${model} failed (${lastErr.message.slice(0, 140)}); trying next model...`);
    }
  }

  throw lastErr ?? new Error('All 9Router models failed');
};

/**
 * Runs structured JSON inference:
 *  1. Uses local 9Router first (avoids Claude CLI usage limit).
 *  2. Falls back to `claude -p` only if 9Router is unreachable and Claude CLI is not in cooldown.
 */
export const runClaudeJson = async <T>(
  prompt: string,
  schema: object,
  options: { tools?: string[]; timeoutMs?: number } = {}
): Promise<T> => {
  try {
    return await run9RouterJson<T>(prompt, schema, options);
  } catch (routerErr) {
    log(
      'WARN',
      'AI-Router',
      `9Router inference failed (${(routerErr as Error).message}); trying Claude CLI fallback if available...`
    );
  }

  if (Date.now() < claudeCliExhaustedUntil) {
    throw new Error('Claude CLI usage limit is in cooldown and 9Router failed');
  }

  const tools = options.tools ?? [];
  const args = [
    '-p',
    prompt,
    '--output-format',
    'json',
    '--json-schema',
    JSON.stringify(schema),
    '--tools',
    tools.join(','),
  ];
  if (tools.length) args.push('--allowedTools', tools.join(','));

  try {
    const { stdout } = await execFileAsync(config.claudeCliPath, args, {
      timeout: options.timeoutMs ?? 120_000,
      maxBuffer: 8 * 1024 * 1024,
    });

    const envelope = JSON.parse(stdout.trim());
    if (envelope.structured_output) return envelope.structured_output as T;
    if (typeof envelope.result === 'string') {
      const match = envelope.result.match(/\{[\s\S]*\}/);
      if (match) return JSON.parse(match[0]) as T;
    }
    throw new Error(`Claude CLI returned no structured output: ${stdout.slice(0, 300)}`);
  } catch (cliErr) {
    const msg = `${(cliErr as Error).message} ${(cliErr as any)?.stdout || ''} ${(cliErr as any)?.stderr || ''}`;
    if (/limit|rate|quota|exhausted|credit|max turns|command failed/i.test(msg)) {
      claudeCliExhaustedUntil = Date.now() + 30 * 60_000;
    }
    throw cliErr;
  }
};
