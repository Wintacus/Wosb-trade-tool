import { supabase } from '../lib/supabase';
import { ensureIdentity } from '../lib/identity';
import type { DraftRow } from './submit';

/**
 * Reading prices off a screenshot (SPEC.md 7.2), from the browser's side.
 *
 * The division of labour: this file prepares the image and hands the answer to
 * the entry screen. It never decides anything. The serverless function holds
 * the API key, checks the fields and enforces the rate limit; the person
 * looking at the review screen decides what is saved.
 *
 * OCR is an accelerator and nothing more. Everything here is allowed to fail —
 * no key configured, no network, an unreadable photo — and the manual entry
 * screen underneath must remain exactly as usable as it was (CLAUDE.md hard
 * rule 6).
 */

/**
 * The longest edge sent to the model.
 *
 * The API downscales anything larger than this itself, so sending a full
 * 1290x2796 phone screenshot spends upload time and request body on pixels
 * that are thrown away. Resizing here also drops the file to a size that
 * comfortably clears the request body limit on a mobile connection.
 */
export const MAX_EDGE = 1568;

/** Above this the PNG is re-encoded as JPEG; below it, stay lossless. */
const PNG_BUDGET_BYTES = 2_000_000;

/** What a phone will hand over from the photo library or camera. */
export const ACCEPTED_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/heic', 'image/heif'];

/** Before any decoding: a 40MB video picked by accident should fail instantly. */
const MAX_FILE_BYTES = 25_000_000;

export interface ExtractedRow {
  goodId: string;
  printed: string;
  buyText: string;
  sellText: string;
  stockText: string;
  flags: string[];
}

export interface Extraction {
  screen: 'market' | 'trade_with_port' | 'unknown';
  portName: string | null;
  portKind: 'city' | 'settlement' | 'unknown';
  rows: ExtractedRow[];
  rejected: { printed: string; reason: string }[];
  notes: string | null;
  model?: string;
}

export interface PreparedImage {
  base64: string;
  mediaType: 'image/png' | 'image/jpeg';
  width: number;
  height: number;
  bytes: number;
}

/** How much to shrink an image so its longest edge is at most MAX_EDGE. */
export function scaleFor(width: number, height: number, maxEdge = MAX_EDGE): number {
  const longest = Math.max(width, height);
  return longest <= maxEdge ? 1 : maxEdge / longest;
}

/**
 * Turn the chosen file into pixels and nothing else.
 *
 * Drawing to a canvas and reading it back is what strips the metadata: a
 * canvas holds pixels, and `toBlob` writes a new file from them, so EXIF —
 * including the GPS coordinates a phone photo of a monitor carries — never
 * exists in what leaves the device (SPEC.md 7.2, safeguard 2). The server
 * strips again, because a caller that is not this browser can skip this step.
 *
 * It also converts HEIC, which is what an iPhone actually stores and which the
 * API does not accept: `createImageBitmap` decodes whatever the browser can
 * display, and what comes out the other side is a PNG.
 */
export async function prepareImage(file: File): Promise<PreparedImage> {
  if (file.size > MAX_FILE_BYTES) {
    throw new Error('That file is far too big to be a screenshot. Pick the screenshot itself.');
  }

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error(
      'That file could not be opened as an image. A screenshot taken on this ' +
        'phone should work; a downloaded or converted file may not.',
    );
  }

  const scale = scaleFor(bitmap.width, bitmap.height);
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('This browser would not give us a canvas to resize the image on.');
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  let blob = await toBlob(canvas, 'image/png');
  let mediaType: 'image/png' | 'image/jpeg' = 'image/png';
  // PNG is lossless, which matters for small digits, so it is the default.
  // JPEG only if the lossless version is too big to send — a compressed price
  // is still better than no price.
  if (blob.size > PNG_BUDGET_BYTES) {
    blob = await toBlob(canvas, 'image/jpeg', 0.92);
    mediaType = 'image/jpeg';
  }

  return { base64: await toBase64(blob), mediaType, width, height, bytes: blob.size };
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('The image could not be re-encoded.'))),
      type,
      quality,
    );
  });
}

async function toBase64(blob: Blob): Promise<string> {
  const buffer = new Uint8Array(await blob.arrayBuffer());
  // Chunked because String.fromCharCode(...arr) on a megabyte of pixels
  // overflows the call stack on Safari.
  let binary = '';
  for (let i = 0; i < buffer.length; i += 8192) {
    binary += String.fromCharCode(...buffer.subarray(i, i + 8192));
  }
  return btoa(binary);
}

/** Send the image to be read. Resolves with what was found; throws with why not. */
export async function readScreenshot(file: File): Promise<Extraction> {
  const image = await prepareImage(file);

  if (!supabase) {
    throw new Error('The app is not connected to its database, so it cannot read screenshots.');
  }
  // The endpoint rate-limits per account, so it needs to know which account.
  // This mints the invisible one on first use, exactly as saving does.
  await ensureIdentity();
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error('Could not confirm who is uploading, so nothing was sent.');

  const response = await fetch('/api/ocr', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ image: image.base64, mediaType: image.mediaType }),
  });

  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok) {
    const detail = typeof body?.error === 'string' ? body.error : `The reader returned ${response.status}.`;
    throw new Error(detail);
  }
  return body as unknown as Extraction;
}

export interface MergeResult {
  drafts: Record<string, DraftRow>;
  /** Fields the screenshot filled in. */
  filled: number;
  /** Fields left alone because someone had already typed there. */
  kept: number;
}

/**
 * Put what was read into the entry sheet, without ever overwriting a person.
 *
 * The rule is one-directional: a field somebody typed by hand wins over
 * anything a machine read, always, and is counted so the screen can say so. A
 * field the previous screenshot filled may be replaced by a newer one, because
 * that is not someone's work being destroyed — it is a re-read.
 *
 * Nothing here validates. The values arrive already checked by the endpoint
 * and are checked once more by `validateRows` on save; this function's only
 * job is the merge, so that "what happens to what I already typed" has exactly
 * one answer in exactly one place.
 */
export function applyExtraction(
  extraction: Extraction,
  existing: Readonly<Record<string, DraftRow>>,
): MergeResult {
  const drafts: Record<string, DraftRow> = { ...existing };
  let filled = 0;
  let kept = 0;

  for (const row of extraction.rows) {
    const before = drafts[row.goodId];
    const origin = { buyText: row.buyText, sellText: row.sellText, stockText: row.stockText };
    const next: DraftRow = {
      goodId: row.goodId,
      buyText: '',
      sellText: '',
      stockText: '',
      ocr: origin,
    };

    for (const field of ['buyText', 'sellText', 'stockText'] as const) {
      const typed = before?.[field]?.trim() ?? '';
      const fromPreviousRead = (before?.ocr?.[field] ?? '').trim();
      const handTyped = typed !== '' && typed !== fromPreviousRead;

      if (handTyped) {
        next[field] = before![field];
        // Only a conflict counts: leaving a hand-typed value where the
        // screenshot found nothing is not something worth reporting.
        if (row[field].trim() !== '') kept += 1;
      } else {
        next[field] = row[field];
        if (row[field].trim() !== '') filled += 1;
      }
    }

    drafts[row.goodId] = next;
  }

  return { drafts, filled, kept };
}

/**
 * Record what a person changed about a machine's reading (SPEC.md 7.2).
 *
 * Structured fields only — a good id, a field name, what was read and what it
 * should have been. Never the image, and nothing that identifies who or where.
 * The point is to make systematic weakness visible: one wrong digit is noise,
 * but "the sell column is read as the buy column on settlement screens" is a
 * fixable prompt, and it only ever shows up in aggregate.
 *
 * Best effort by design. This is telemetry about a save that has already
 * succeeded; failing it must never turn a successful save into an error on the
 * user's screen.
 */
export async function logCorrections(rows: readonly DraftRow[], screen: string): Promise<number> {
  if (!supabase) return 0;
  const entries: {
    screen_type: string;
    field_name: string;
    ocr_value: string;
    corrected_value: string;
  }[] = [];

  for (const row of rows) {
    const origin = row.ocr;
    if (!origin) continue;
    for (const field of ['buyText', 'sellText', 'stockText'] as const) {
      const read = origin[field].trim();
      const kept = row[field].trim();
      if (read === kept) continue;
      entries.push({
        screen_type: screen,
        // The good is part of the field name so a pattern per good is visible
        // without the table holding anything else about the submission.
        field_name: `${row.goodId}.${field.replace('Text', '')}`,
        ocr_value: read,
        corrected_value: kept,
      });
    }
  }

  if (entries.length === 0) return 0;
  const { error } = await supabase.from('ocr_corrections').insert(entries);
  return error ? 0 : entries.length;
}
