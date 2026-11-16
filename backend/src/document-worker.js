import { parentPort, workerData } from "node:worker_threads";

// Runs in a worker thread with a memory cap so a hostile or damaged file cannot
// exhaust the server. Only plain text leaves this thread.
const { kind, maxCharacters, maxPages } = workerData;
const bytes = Buffer.from(workerData.bytes);

class Unreadable extends Error {}

function tooLong() {
  throw new Unreadable(
    "This document has more than " + maxCharacters.toLocaleString("en-US") +
    " characters of text. Upload a shorter section."
  );
}

function bounded(text) {
  if (text.length > maxCharacters) tooLong();
  return text;
}

function decodeText(buffer) {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.subarray(2).toString("utf16le");
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    const swapped = Buffer.from(buffer.subarray(2));
    swapped.swap16();
    return swapped.toString("utf16le");
  }
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch (error) {
    throw new Unreadable("This TXT file is not UTF-8 text. Save it as UTF-8 and upload it again.");
  }
  if (text.includes("\u0000")) throw new Unreadable("This TXT file is not readable text.");
  return text.replace(/^\uFEFF/, "");
}

async function readPdf(buffer) {
  if (!buffer.subarray(0, 1024).toString("latin1").includes("%PDF-")) {
    throw new Unreadable("This file is not a readable PDF.");
  }
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loading = getDocument({
    data: new Uint8Array(buffer),
    isEvalSupported: false,
    useSystemFonts: false,
    disableFontFace: true,
    stopAtErrors: false,
    verbosity: 0,
  });
  let pdf;
  try {
    pdf = await loading.promise;
  } catch (error) {
    if (error && error.name === "PasswordException") {
      throw new Unreadable("This PDF is password protected. Remove the password and upload it again.");
    }
    throw new Unreadable("This PDF could not be read. It may be damaged.");
  }
  try {
    if (pdf.numPages > maxPages) {
      throw new Unreadable("This PDF has more than " + maxPages + " pages. Upload a shorter section.");
    }
    const pages = [];
    let length = 0;
    for (let number = 1; number <= pdf.numPages; number += 1) {
      const page = await pdf.getPage(number);
      const content = await page.getTextContent();
      const text = content.items
        .map((item) => (typeof item.str === "string" ? item.str : "") + (item.hasEOL ? "\n" : " "))
        .join("")
        .replace(/[ \t]+\n/g, "\n")
        .trim();
      page.cleanup();
      length += text.length;
      if (length > maxCharacters) tooLong();
      pages.push("[Page " + number + "]\n" + text);
    }
    const body = pages.join("\n\n");
    if (!body.replace(/\[Page \d+\]/g, "").trim()) {
      throw new Unreadable(
        "This PDF has no selectable text. It may be a scanned image, and QuickCalAI cannot read scanned documents (no OCR)."
      );
    }
    return { text: body, pages: pdf.numPages };
  } finally {
    await loading.destroy();
  }
}

// DOCX is a ZIP archive. Check the declared expanded sizes before the parser
// inflates anything, so a small file cannot expand into a huge one.
function checkArchive(buffer) {
  let entries = 0;
  let expanded = 0;
  let found = false;
  for (let position = 0; position + 46 <= buffer.length; position += 1) {
    if (buffer.readUInt32LE(position) !== 0x02014b50) continue;
    found = true;
    entries += 1;
    expanded += buffer.readUInt32LE(position + 24);
    if (entries > 2000 || expanded > 40 * 1024 * 1024) {
      throw new Unreadable("This DOCX file expands beyond the supported size. Upload a shorter section.");
    }
    position += 45 + buffer.readUInt16LE(position + 28) + buffer.readUInt16LE(position + 30) + buffer.readUInt16LE(position + 32);
  }
  if (!found || buffer.readUInt32LE(0) !== 0x04034b50) throw new Unreadable("This file is not a readable DOCX document.");
}

async function readDocx(buffer) {
  checkArchive(buffer);
  const mammoth = await import("mammoth");
  let result;
  try {
    result = await mammoth.extractRawText({ buffer: buffer });
  } catch (error) {
    throw new Unreadable("This DOCX file could not be read. It may be damaged or password protected.");
  }
  return { text: result.value, pages: null };
}

try {
  let read;
  if (kind === "pdf") read = await readPdf(bytes);
  else if (kind === "docx") read = await readDocx(bytes);
  else read = { text: decodeText(bytes), pages: null };
  const text = bounded(read.text.replace(/\r\n?/g, "\n").replace(/\n{4,}/g, "\n\n\n").trim());
  if (!text) throw new Unreadable("This document has no readable text.");
  parentPort.postMessage({ ok: true, text: text, pages: read.pages });
} catch (error) {
  parentPort.postMessage({
    ok: false,
    error: error instanceof Unreadable
      ? error.message
      : "This document could not be read. Check that it is not damaged or password protected.",
  });
}
