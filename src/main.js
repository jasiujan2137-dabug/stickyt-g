

import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile, toBlobURL } from "@ffmpeg/util";

const $ = (id) => document.getElementById(id);
const LIMIT = 256 * 1024;
const MAX_SECONDS = 3;
const FPS = 30;
const SIZE = 512;

let ffmpeg;
let loaded = false;
let busy = false;
let cancelled = false;
let sourceFile = null;
let sourceURL = null;
let outputURL = null;

function status(message, type = "") {
  $("status").textContent = message;
  $("status").className = type;
}

function progress(value, message) {
  $("progress").value = value;
  $("progressText").textContent = message;
}

function formatSize(bytes) {
  return `${(bytes / 1024).toFixed(1)} KiB`;
}

function clearOutput() {
  if (outputURL) URL.revokeObjectURL(outputURL);
  outputURL = null;
  $("result").hidden = true;
}

$("thickness").addEventListener("input", () => {
  $("tv").textContent = `${$("thickness").value} px`;
});

$("shadow").addEventListener("input", () => {
  $("sv").textContent = `${$("shadow").value}%`;
});

$("quality").addEventListener("input", () => {
  $("qv").textContent = $("quality").value;
});

$("file").addEventListener("change", (event) => {
  const file = event.target.files?.[0];
  if (!file || busy) return;

  sourceFile = file;
  clearOutput();

  if (sourceURL) URL.revokeObjectURL(sourceURL);
  sourceURL = URL.createObjectURL(file);

  $("source").src = sourceURL;
  $("source").hidden = false;
  $("placeholder").hidden = true;
  $("fileInfo").textContent =
    `${file.name} • ${formatSize(file.size)}`;

  $("convert").disabled = false;
  status("");
  progress(0, "Plik wybrany. Gotowy do konwersji.");
});

async function loadEngine() {
  if (loaded) return;

  progress(2, "Uruchamianie silnika FFmpeg…");
  status("Pierwsze uruchomienie wymaga pobrania silnika.");

  ffmpeg = new FFmpeg();

  ffmpeg.on("log", ({ message }) => {
    console.log("[FFmpeg]", message);
  });

  ffmpeg.on("progress", ({ progress: value }) => {
    if (busy && Number.isFinite(value)) {
      progress(
        Math.max(10, Math.min(85, Math.round(value * 75))),
        "Przetwarzanie filmu…"
      );
    }
  });

  const base =
    "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/umd";

  const coreURL = await toBlobURL(
    `${base}/ffmpeg-core.js`,
    "text/javascript"
  );

  const wasmURL = await toBlobURL(
    `${base}/ffmpeg-core.wasm`,
    "application/wasm"
  );

  await ffmpeg.load({ coreURL, wasmURL });
  loaded = true;
}

async function removeFile(name) {
  try {
    await ffmpeg.deleteFile(name);
  } catch {}
}

async function exec(args) {
  if (cancelled) throw new Error("Konwersja anulowana.");

  const code = await ffmpeg.exec(args);

  if (code !== 0) {
    throw new Error(
      "FFmpeg zgłosił błąd. Sprawdź konsolę przeglądarki."
    );
  }

  if (cancelled) throw new Error("Konwersja anulowana.");
}

async function readDuration() {
  let logs = "";

  const handler = ({ message }) => {
    logs += `${message}\n`;
  };

  ffmpeg.on("log", handler);

  try {
    await ffmpeg.exec(["-i", "input.mov"]);
  } catch {
    // Odczyt informacji o pliku może zwrócić kod błędu.
  } finally {
    ffmpeg.off("log", handler);
  }

  const match = logs.match(
    /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/
  );

  if (!match) {
    throw new Error(
      "Nie można odczytać filmu. Spróbuj innego pliku MOV."
    );
  }

  return (
    Number(match[1]) * 3600 +
    Number(match[2]) * 60 +
    Number(match[3])
  );
}

async function makeFrames() {
  await exec([
    "-i", "input.mov",
    "-t", String(MAX_SECONDS),
    "-an",
    "-vf",
    `fps=${FPS},scale=${SIZE}:${SIZE}:force_original_aspect_ratio=decrease,pad=${SIZE}:${SIZE}:(ow-iw)/2:(oh-ih)/2:color=black@0,format=rgba`,
    "-frames:v", String(FPS * MAX_SECONDS),
    "-start_number", "1",
    "frame%04d.png"
  ]);

  const frames = [];

  for (let i = 1; i <= FPS * MAX_SECONDS; i++) {
    const name = `frame${String(i).padStart(4, "0")}.png`;

    try {
      await ffmpeg.readFile(name);
      frames.push(name);
    } catch {
      break;
    }
  }

  if (!frames.length) {
    throw new Error("Nie udało się odczytać klatek filmu.");
  }

  return frames;
}

async function addFrame(frames) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = SIZE;

  const ctx = canvas.getContext("2d");
  const mask = document.createElement("canvas");
  mask.width = mask.height = SIZE;

  const mctx = mask.getContext("2d");

  const enabled = $("frame").checked;
  const thickness = Number($("thickness").value);
  const color = $("color").value;
  const shadow = Number($("shadow").value) / 100;

  for (let index = 0; index < frames.length; index++) {
    if (cancelled) throw new Error("Konwersja anulowana.");

    const name = frames[index];
    const data = await ffmpeg.readFile(name);
    const bitmap = await createImageBitmap(
      new Blob([data], { type: "image/png" })
    );

    ctx.clearRect(0, 0, SIZE, SIZE);
    mctx.clearRect(0, 0, SIZE, SIZE);

    if (enabled) {
      mctx.drawImage(bitmap, 0, 0);

      const steps = Math.max(24, thickness * 12);

      for (let radius = 1; radius <= thickness; radius++) {
        for (let i = 0; i < steps; i++) {
          const angle = (i / steps) * Math.PI * 2;
          mctx.drawImage(
            bitmap,
            Math.cos(angle) * radius,
            Math.sin(angle) * radius
          );
        }
      }

      const image = mctx.getImageData(0, 0, SIZE, SIZE);

      for (let p = 0; p < image.data.length; p += 4) {
        if (image.data[p + 3] > 0) {
          image.data[p] = parseInt(color.slice(1, 3), 16);
          image.data[p + 1] = parseInt(color.slice(3, 5), 16);
          image.data[p + 2] = parseInt(color.slice(5, 7), 16);
          image.data[p + 3] = 255;
        }
      }

      mctx.putImageData(image, 0, 0);

      if (shadow > 0) {
        ctx.save();
        ctx.shadowColor = `rgba(0,0,0,${shadow * 0.65})`;
        ctx.shadowBlur = 2 + shadow * 8;
        ctx.shadowOffsetY = 1 + shadow * 3;
        ctx.drawImage(mask, 0, 0);
        ctx.restore();
      }

      ctx.drawImage(mask, 0, 0);
    }

    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();

    const png = await new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error("Nie udało się zapisać klatki."));
      }, "image/png");
    });

    await ffmpeg.writeFile(
      name,
      new Uint8Array(await png.arrayBuffer())
    );

    progress(
      10 + Math.round(((index + 1) / frames.length) * 45),
      `Przygotowywanie klatek: ${index + 1}/${frames.length}`
    );
  }
}

async function convert() {
  if (!sourceFile || busy) return;

  busy = true;
  cancelled = false;
  $("convert").disabled = true;
  $("cancel").disabled = false;
  clearOutput();

  try {
    await loadEngine();

    await removeFile("input.mov");
    await ffmpeg.writeFile(
      "input.mov",
      await fetchFile(sourceFile)
    );

    progress(8, "Sprawdzanie długości filmu…");
    const duration = await readDuration();

    if (duration > MAX_SECONDS + 0.001) {
      throw new Error(
        `Film ma ${duration.toFixed(2)} s. Maksymalna długość to 3 sekundy.`
      );
    }

    progress(10, "Wyodrębnianie klatek…");
    const frames = await makeFrames();

    await addFrame(frames);

    const start = Number($("quality").value);
    const attempts = [...new Set([
      start,
      Math.max(start, 35),
      Math.max(start, 40),
      Math.max(start, 45),
      50
    ])];

    let output = null;
    let usedQuality = start;

    for (let i = 0; i < attempts.length; i++) {
      if (cancelled) throw new Error("Konwersja anulowana.");

      usedQuality = attempts[i];

      progress(
        55 + Math.round((i / attempts.length) * 40),
        `Kompresja WEBM: próba ${i + 1}/${attempts.length}`
      );

      await removeFile("output.webm");

      await exec([
        "-framerate", String(FPS),
        "-start_number", "1",
        "-i", "frame%04d.png",
        "-an",
        "-c:v", "libvpx-vp9",
        "-pix_fmt", "yuva420p",
        "-auto-alt-ref", "0",
        "-deadline", "good",
        "-cpu-used", "4",
        "-crf", String(usedQuality),
        "-b:v", "0",
        "-t", String(MAX_SECONDS),
        "-metadata:s:v:0", "alpha_mode=1",
        "output.webm"
      ]);

      const data = await ffmpeg.readFile("output.webm");

      if (data.length <= LIMIT) {
        output = data;
        break;
      }
    }

    if (!output) {
      throw new Error(
        "Plik przekracza 256 KiB. Spróbuj prostszego lub krótszego filmu."
      );
    }

    outputURL = URL.createObjectURL(
      new Blob([output], { type: "video/webm" })
    );

    $("outputPreview").src = outputURL;
    $("outputPreview").load();
    $("download").href = outputURL;

    $("resultInfo").textContent =
      `${formatSize(output.length)} • ${frames.length} klatek • VP9 • CRF ${usedQuality}`;

    $("result").hidden = false;
    progress(100, "Konwersja zakończona.");
    status("Gotowe! Możesz obejrzeć i pobrać naklejkę.", "success");
  } catch (error) {
    console.error(error);
    progress(0, "Konwersja nie została zakończona.");
    status(error?.message || String(error), "error");
  } finally {
    busy = false;
    cancelled = false;
    $("convert").disabled = !sourceFile;
    $("cancel").disabled = true;
  }
}

$("convert").addEventListener("click", convert);

$("cancel").addEventListener("click", () => {
  cancelled = true;
  status("Anulowanie operacji…");
});
