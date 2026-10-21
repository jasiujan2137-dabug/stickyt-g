
import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile, toBlobURL } from "@ffmpeg/util";

const $ = (id) => document.getElementById(id);
const LIMIT = 256 * 1024;

let ffmpeg;
let loaded = false;
let busy = false;
let cancelled = false;
let sourceFile = null;
let outputURL = null;
let sourceURL = null;

function setStatus(message, type = "") {
  $("status").textContent = message;
  $("status").className = type;
}

function setProgress(value, message) {
  $("progress").value = value;
  $("progressText").textContent = message;
}

function formatSize(bytes) {
  return (bytes / 1024).toFixed(1) + " KiB";
}

$("thickness").addEventListener("input", () => {
  $("tv").textContent = $("thickness").value + " px";
});

$("shadow").addEventListener("input", () => {
  $("sv").textContent = $("shadow").value + "%";
});

$("quality").addEventListener("input", () => {
  $("qv").textContent = $("quality").value;
});

function clearOutput() {
  if (outputURL) URL.revokeObjectURL(outputURL);
  outputURL = null;
  $("result").hidden = true;
}

$("file").addEventListener("change", (event) => {
  const file = event.target.files?.[0];
  if (!file) return;

  if (busy) {
    setStatus("Najpierw anuluj bieżącą konwersję.", "error");
    return;
  }

  sourceFile = file;
  clearOutput();

  if (sourceURL) URL.revokeObjectURL(sourceURL);
  sourceURL = URL.createObjectURL(file);

  $("source").src = sourceURL;
  $("source").hidden = false;
  $("placeholder").hidden = true;
  $("fileInfo").textContent = `${file.name} • ${formatSize(file.size)}`;
  $("convert").disabled = false;

  setStatus("");
  setProgress(0, "Plik wybrany. Gotowy do konwersji.");

  // MOV ProRes może nie być odtwarzany bezpośrednio przez przeglądarkę.
  $("source").load();
});

async function loadEngine() {
  if (loaded) return;

  setProgress(2, "Uruchamianie FFmpeg…");
  setStatus("Pobieranie silnika konwersji. Poczekaj.");

  ffmpeg = new FFmpeg();

  ffmpeg.on("log", ({ message }) => {
    console.log("[FFmpeg]", message);
  });

  ffmpeg.on("progress", ({ progress }) => {
    if (busy && Number.isFinite(progress)) {
      setProgress(
        Math.max(5, Math.min(90, Math.round(progress * 80))),
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

  // FFmpeg jest importowany z pakietu projektu.
  // Vite przygotuje Worker podczas budowania strony.
  await ffmpeg.load({ coreURL, wasmURL });

  loaded = true;
  setProgress(5, "Silnik gotowy.");
}

async function removeFile(name) {
  try {
    await ffmpeg.deleteFile(name);
  } catch {}
}

async function runFFmpeg(args) {
  if (cancelled) throw new Error("Konwersja anulowana.");

  const code = await ffmpeg.exec(args);

  if (code !== 0) {
    throw new Error(
      "FFmpeg nie ukończył operacji. Szczegóły znajdziesz w konsoli przeglądarki."
    );
  }

  if (cancelled) throw new Error("Konwersja anulowana.");
}

async function getDuration() {
  let logs = "";

  const handler = ({ message }) => {
    logs += message + "\n";
  };

  ffmpeg.on("log", handler);

  try {
    await ffmpeg.exec(["-i", "input.mov"]);
  } catch {
    // Samo -i bez wyjścia może zwrócić kod błędu.
    // Interesuje nas odczytana informacja Duration.
  } finally {
    ffmpeg.off("log", handler);
  }

  const match = logs.match(
    /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/
  );

  if (!match) {
    throw new Error(
      "Nie udało się odczytać długości filmu. Plik może być uszkodzony lub nieobsługiwany."
    );
  }

  return (
    Number(match[1]) * 3600 +
    Number(match[2]) * 60 +
    Number(match[3])
  );
}

async function makeFrames() {
  await runFFmpeg([
    "-i", "input.mov",
    "-an",
    "-t", "3.001",
    "-vf",
    "fps=30,scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=black@0,format=rgba",
    "-frames:v", "91",
    "-start_number", "1",
    "frame%04d.png"
  ]);

  const frames = [];

  for (let i = 1; i <= 91; i++) {
    const name = `frame${String(i).padStart(4, "0")}.png`;

    try {
      await ffmpeg.readFile(name);
      frames.push(name);
    } catch {
      break;
    }
  }

  if (!frames.length) {
    throw new Error("Nie udało się wyodrębnić klatek z filmu.");
  }

  if (frames.length > 90) {
    throw new Error("Film przekracza 3 sekundy przy 30 FPS.");
  }

  return frames;
}

async function addFrame(frames) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 512;

  const ctx = canvas.getContext("2d", {
    willReadFrequently: true
  });

  const mask = document.createElement("canvas");
  mask.width = mask.height = 512;

  const mctx = mask.getContext("2d", {
    willReadFrequently: true
  });

  const enabled = $("frame").checked;
  const thickness = Number($("thickness").value);
  const color = $("color").value;
  const shadow = Number($("shadow").value) / 100;

  const rgb = [
    parseInt(color.slice(1, 3), 16),
    parseInt(color.slice(3, 5), 16),
    parseInt(color.slice(5, 7), 16)
  ];

  for (let index = 0; index < frames.length; index++) {
    if (cancelled) throw new Error("Konwersja anulowana.");

    const name = frames[index];
    const data = await ffmpeg.readFile(name);

    const bitmap = await createImageBitmap(
      new Blob([data], { type: "image/png" })
    );

    ctx.clearRect(0, 0, 512, 512);
    mctx.clearRect(0, 0, 512, 512);

    if (enabled) {
      mctx.drawImage(bitmap, 0, 0);

      // Rozszerzamy sylwetkę obiektu, zachowując przezroczyste tło.
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

      const image = mctx.getImageData(0, 0, 512, 512);

      for (let p = 0; p < image.data.length; p += 4) {
        if (image.data[p + 3] > 0) {
          image.data[p] = rgb[0];
          image.data[p + 1] = rgb[1];
          image.data[p + 2] = rgb[2];
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

    // Oryginalny obraz pozostaje na wierzchu.
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

    setProgress(
      10 + Math.round(((index + 1) / frames.length) * 45),
      `Ramka: ${index + 1}/${frames.length}`
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
    await ffmpeg.writeFile("input.mov", await fetchFile(sourceFile));

    setProgress(8, "Sprawdzanie długości filmu…");

    const duration = await getDuration();

    if (duration > 3.001) {
      throw new Error(
        `Za długi film: ${duration.toFixed(2)} s. Maksymalnie 3 sekundy.`
      );
    }

    setProgress(10, "Wyodrębnianie klatek…");

    const frames = await makeFrames();

    await addFrame(frames);

    const startCRF = Number($("quality").value);
    const attempts = [
      ...new Set([
        startCRF,
        Math.max(startCRF, 35),
        Math.max(startCRF, 40),
        Math.max(startCRF, 45),
        50
      ])
    ];

    let output = null;
    let usedCRF = startCRF;

    for (let i = 0; i < attempts.length; i++) {
      if (cancelled) throw new Error("Konwersja anulowana.");

      usedCRF = attempts[i];

      setProgress(
        55 + Math.round((i / attempts.length) * 40),
        `Kompresja VP9 — CRF ${usedCRF}…`
      );

      await removeFile("output.webm");

      await runFFmpeg([
        "-framerate", "30",
        "-start_number", "1",
        "-i", "frame%04d.png",
        "-an",
        "-c:v", "libvpx-vp9",
        "-pix_fmt", "yuva420p",
        "-auto-alt-ref", "0",
        "-deadline", "good",
        "-cpu-used", "4",
        "-crf", String(usedCRF),
        "-b:v", "0",
        "-t", "3",
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
        "Nie udało się zmieścić pliku w 256 KiB. Spróbuj uprościć animację."
      );
    }

    outputURL = URL.createObjectURL(
      new Blob([output], { type: "video/webm" })
    );

    $("outputPreview").src = outputURL;
    $("outputPreview").load();

    $("download").href = outputURL;
    $("resultInfo").textContent =
      `${formatSize(output.length)} • ${frames.length} klatek • ` +
      `VP9 • CRF ${usedCRF}`;

    $("result").hidden = false;

    setProgress(100, "Konwersja zakończona.");
    setStatus("Gotowe! Sprawdź podgląd i pobierz plik.", "success");
  } catch (error) {
    console.error(error);

    setProgress(0, "Konwersja nie została zakończona.");
    setStatus(error?.message || String(error), "error");
  } finally {
    busy = false;
    $("convert").disabled = !sourceFile;
    $("cancel").disabled = true;
    cancelled = false;
  }
}

$("convert").addEventListener("click", convert);

$("cancel").addEventListener("click", () => {
  cancelled = true;
  setStatus("Anulowanie operacji…");
});
