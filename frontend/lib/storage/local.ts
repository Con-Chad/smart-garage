import { randomUUID } from "node:crypto";
import { mkdir, writeFile, unlink, readFile } from "node:fs/promises";
import path from "node:path";
import {
  ALLOWED_DOCUMENT_MIME_TYPES,
  ALLOWED_IMAGE_MIME_TYPES,
  getMaxImageSizeBytes,
  getMaxUploadSizeBytes,
  resolveStoredFilePath,
} from "./paths";
import { contentMatchesMimeType } from "./sniff";

export type SavedFile = {
  storageKey: string;
  originalFilename: string;
  mimeType: string;
  sizeBytes: bigint;
};

/** Longest original file name kept; anything past it is noise in `Content-Disposition`. */
const MAX_ORIGINAL_FILENAME_LENGTH = 255;

/**
 * File names come from the client (`file.name`) or a backup file. Keep them
 * printable and bounded: control characters are stripped and the result is
 * cut to 255 characters, with "file" as the fallback for an empty name.
 */
export function sanitizeOriginalFilename(name: unknown): string {
  const cleaned = String(name ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, MAX_ORIGINAL_FILENAME_LENGTH);
  return cleaned || "file";
}

export function extensionForMime(mimeType: string): string {
  switch (mimeType) {
    case "image/jpeg":
      return ".jpg";
    case "image/png":
      return ".png";
    case "image/webp":
      return ".webp";
    case "image/gif":
      return ".gif";
    case "application/pdf":
      return ".pdf";
    default:
      return "";
  }
}

async function saveFileToStorage(
  storageKey: string,
  file: File,
  allowedMimeTypes: Set<string>,
  maxBytes: number,
): Promise<SavedFile> {
  if (!allowedMimeTypes.has(file.type)) {
    throw new Error("INVALID_FILE_TYPE");
  }

  if (file.size > maxBytes) {
    throw new Error("FILE_TOO_LARGE");
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  if (!contentMatchesMimeType(buffer, file.type)) {
    throw new Error("INVALID_FILE_TYPE");
  }

  const absolutePath = resolveStoredFilePath(storageKey);

  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, buffer);

  return {
    storageKey,
    originalFilename: sanitizeOriginalFilename(file.name),
    mimeType: file.type,
    sizeBytes: BigInt(file.size),
  };
}

export async function saveVehicleImage(
  vehicleId: string,
  file: File,
): Promise<SavedFile> {
  const ext = extensionForMime(file.type) || path.extname(file.name) || ".jpg";
  const filename = `${randomUUID()}${ext}`;
  const storageKey = path.posix.join("vehicles", vehicleId, filename);
  return saveFileToStorage(
    storageKey,
    file,
    ALLOWED_IMAGE_MIME_TYPES,
    getMaxImageSizeBytes(),
  );
}

export async function saveVehicleDocument(
  vehicleId: string,
  file: File,
): Promise<SavedFile> {
  const ext = extensionForMime(file.type) || path.extname(file.name) || ".bin";
  const filename = `${randomUUID()}${ext}`;
  const storageKey = path.posix.join(
    "vehicles",
    vehicleId,
    "documents",
    filename,
  );
  return saveFileToStorage(
    storageKey,
    file,
    ALLOWED_DOCUMENT_MIME_TYPES,
    getMaxUploadSizeBytes(),
  );
}

export async function saveUserBackgroundImage(
  userId: string,
  file: File,
): Promise<SavedFile> {
  const ext = extensionForMime(file.type) || path.extname(file.name) || ".jpg";
  const storageKey = path.posix.join("users", userId, `background${ext}`);
  return saveFileToStorage(
    storageKey,
    file,
    ALLOWED_IMAGE_MIME_TYPES,
    getMaxImageSizeBytes(),
  );
}

export async function readStoredFile(storageKey: string): Promise<Buffer> {
  const absolutePath = resolveStoredFilePath(storageKey);
  return readFile(absolutePath);
}

export async function restoreStoredFile(
  storageKey: string,
  data: Buffer,
): Promise<void> {
  const absolutePath = resolveStoredFilePath(storageKey);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, data);
}

export async function deleteStoredFile(storageKey: string): Promise<void> {
  const absolutePath = resolveStoredFilePath(storageKey);
  try {
    await unlink(absolutePath);
  } catch {
    // File may already be removed
  }
}
