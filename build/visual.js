import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import sharp from "sharp";
import { randomUUID } from "node:crypto";
// Local SSIM plus RGB error catches both structural and flat-color changes.
export function difference(a, b, width, height, ignore = []) {
    if (a.length !== width * height * 3 || b.length !== a.length)
        throw new Error("Frame dimensions must match.");
    let sum = 0, pixels = 0, changed = 0, peak = 0, ssimSum = 0, tiles = 0;
    for (let y = 0; y < height; y += 8)
        for (let x = 0; x < width; x += 8) {
            let n = 0, sx = 0, sy = 0, xx = 0, yy = 0, xy = 0, delta = 0;
            for (let j = y; j < Math.min(y + 8, height); j++)
                for (let i = x; i < Math.min(x + 8, width); i++) {
                    if (ignore.some(r => i / width >= r.x && i / width < r.x + r.width && j / height >= r.y && j / height < r.y + r.height))
                        continue;
                    const k = (j * width + i) * 3;
                    const u = .2126 * a[k] + .7152 * a[k + 1] + .0722 * a[k + 2];
                    const v = .2126 * b[k] + .7152 * b[k + 1] + .0722 * b[k + 2];
                    const d = (Math.abs(a[k] - b[k]) + Math.abs(a[k + 1] - b[k + 1]) + Math.abs(a[k + 2] - b[k + 2])) / (3 * 255);
                    delta += d;
                    sum += d;
                    pixels++;
                    if (d > .04)
                        changed++;
                    n++;
                    sx += u;
                    sy += v;
                    xx += u * u;
                    yy += v * v;
                    xy += u * v;
                }
            if (!n)
                continue;
            const mx = sx / n, my = sy / n;
            const vx = Math.max(0, xx / n - mx * mx), vy = Math.max(0, yy / n - my * my), cov = xy / n - mx * my;
            ssimSum += ((2 * mx * my + 6.5025) * (2 * cov + 58.5225)) / ((mx * mx + my * my + 6.5025) * (vx + vy + 58.5225));
            tiles++;
            peak = Math.max(peak, delta / n);
        }
    if (!pixels)
        throw new Error("Ignore regions cover the entire frame.");
    return { meanDifference: sum / pixels, peakTileDifference: peak, ssim: ssimSum / tiles, changedFraction: changed / pixels };
}
export async function indexVideo(ffmpeg, video, start, end, fps = 15) {
    if (!(end > start) || end - start > 3600 || fps < 1 || fps > 60)
        throw new Error("Index a valid range up to one hour at 1–60 FPS.");
    const stat = await fs.stat(video);
    const cache = `${video}.index-${start}-${end}-${fps}.json`;
    const key = `${stat.size}:${stat.mtimeMs}:v1`;
    const cached = await fs.readFile(cache, "utf8").then(JSON.parse).catch(() => undefined);
    if (cached?.key === key)
        return cached.index;
    const width = 160, height = 90, bytes = width * height * 3;
    const index = await new Promise((resolve, reject) => {
        const child = spawn(ffmpeg, ["-hide_banner", "-loglevel", "error", "-ss", String(start), "-protocol_whitelist", "file,pipe", "-i", video, "-t", String(end - start), "-an", "-vf", `fps=${fps},scale=${width}:${height}`, "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
        let pending = Buffer.alloc(0), previous, count = 0, stderr = "", staticFrames = 0, darkFrames = 0;
        const bins = new Map();
        const timeout = setTimeout(() => { child.kill(); reject(new Error("Visual indexing timed out; inspect a shorter range.")); }, 120_000);
        child.stderr.on("data", chunk => { stderr = (stderr + String(chunk)).slice(-2000); });
        child.stdout.on("data", (chunk) => {
            pending = Buffer.concat([pending, chunk]);
            while (pending.length >= bytes) {
                const frame = pending.subarray(0, bytes);
                let brightness = 0;
                for (const value of frame)
                    brightness += value;
                if (brightness / bytes < 3)
                    darkFrames++;
                if (previous) {
                    const d = difference(previous, frame, width, height);
                    const score = Math.max(d.peakTileDifference, 1 - d.ssim);
                    if (d.meanDifference < .0005)
                        staticFrames++;
                    if (score >= .035) {
                        const timestamp = start + count / fps, bin = Math.floor((timestamp - start) * 2);
                        if (!bins.has(bin) || bins.get(bin).score < score)
                            bins.set(bin, { timestamp, score });
                    }
                }
                previous = Buffer.from(frame);
                pending = pending.subarray(bytes);
                count++;
            }
        });
        child.on("error", e => { clearTimeout(timeout); reject(e); });
        child.on("close", code => {
            clearTimeout(timeout);
            if (code || !count || pending.length)
                return reject(new Error(`Visual indexing failed: ${stderr || "no complete frames"}`));
            const warnings = [];
            if (darkFrames / count > .95)
                warnings.push("Almost all frames are black; check permissions, protected content, and target rendering.");
            if (staticFrames / Math.max(1, count - 1) > .98)
                warnings.push("Nearly static recording: may be an idle application, a frozen capture, or a minimized target. This is not a defect diagnosis.");
            const changes = [...bins.values()].sort((a, b) => b.score - a.score).slice(0, 256).sort((a, b) => a.timestamp - b.timestamp);
            resolve({ fps, decodedFrames: count, width, height, changes, warnings });
        });
    });
    const temp = `${cache}.${randomUUID()}.tmp`;
    await fs.writeFile(temp, JSON.stringify({ key, index }));
    await fs.rename(temp, cache);
    return index;
}
export async function compareVideos(media, before, after, directory, options) {
    if (options.seconds <= 0 || options.samples < 2 || options.samples > 60)
        throw new Error("Compare a positive duration with 2–60 samples.");
    await fs.mkdir(directory, { recursive: true });
    const rows = [];
    const htmlRows = [];
    for (let i = 0; i < options.samples; i++) {
        const offset = i * options.seconds / options.samples;
        const a = path.join(directory, `before-${i}.png`), b = path.join(directory, `after-${i}.png`);
        await media.extractFrame(before, options.beforeStart + offset, a, 640);
        await media.extractFrame(after, options.afterStart + offset, b, 640);
        const raw = async (file) => sharp(file).resize(320, 180, { fit: "contain", background: "black" }).removeAlpha().raw().toBuffer();
        const [left, right] = await Promise.all([raw(a), raw(b)]);
        const metrics = difference(left, right, 320, 180, options.ignore);
        const score = Math.max(metrics.peakTileDifference, 1 - metrics.ssim);
        const row = { beforeSeconds: options.beforeStart + offset, afterSeconds: options.afterStart + offset, ...metrics, score, changed: score >= options.threshold };
        rows.push(row);
        const mask = Buffer.alloc(left.length);
        for (let p = 0; p < left.length; p += 3) {
            const x = (p / 3 % 320) / 320, y = Math.floor(p / 3 / 320) / 180;
            const ignored = options.ignore.some(r => x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height);
            const delta = Math.max(Math.abs(left[p] - right[p]), Math.abs(left[p + 1] - right[p + 1]), Math.abs(left[p + 2] - right[p + 2]));
            mask[p] = ignored ? 0 : Math.min(255, delta * 4);
            mask[p + 1] = ignored ? 0 : delta;
        }
        const heatmap = await sharp(mask, { raw: { width: 320, height: 180, channels: 3 } }).png().toBuffer();
        await fs.writeFile(path.join(directory, `difference-${i}.png`), heatmap);
        const [aData, bData] = await Promise.all([fs.readFile(a), fs.readFile(b)]);
        htmlRows.push(`<section><h2>${row.beforeSeconds.toFixed(3)}s → ${row.afterSeconds.toFixed(3)}s · ${row.changed ? "Changed" : "Within threshold"}</h2><p>SSIM ${metrics.ssim.toFixed(4)} · changed pixels ${(metrics.changedFraction * 100).toFixed(2)}%</p><div>${[aData, bData, heatmap].map((data, j) => `<figure><img alt="${["Before", "After", "Difference"][j]}" src="data:image/png;base64,${data.toString("base64")}"><figcaption>${["Before", "After", "Difference"][j]}</figcaption></figure>`).join("")}</div></section>`);
    }
    const report = { schemaVersion: 1, options, changedSamples: rows.filter(row => row.changed).length, rows, note: "Visual differences are candidates for review, not confirmed regressions. Only sampled timestamps are compared; motion between them may be missed." };
    await fs.writeFile(path.join(directory, "report.json"), JSON.stringify(report, null, 2));
    await fs.writeFile(path.join(directory, "report.html"), `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>ClipQA comparison</title><style>body{font:16px system-ui;background:#0d1117;color:#e6edf3;margin:32px}section{border-top:1px solid #30363d;padding:16px 0}div{display:flex;flex-wrap:wrap;gap:12px}figure{margin:0;flex:1;min-width:240px}img{width:100%}figcaption{color:#8b949e}h2{font-size:18px}</style><h1>ClipQA comparison</h1><p>${report.changedSamples}/${rows.length} samples changed. ${report.note}</p>${htmlRows.join("")}</html>`);
    const worst = rows.reduce((best, row, i) => row.score > rows[best].score ? i : best, 0);
    const previewPath = path.join(directory, "preview.jpg");
    const previews = await Promise.all(["before", "after", "difference"].map(async (name, i) => ({ input: await sharp(path.join(directory, `${name}-${worst}.png`)).resize(320, 180, { fit: "contain", background: "black" }).png().toBuffer(), left: i * 320, top: 0 })));
    await sharp({ create: { width: 960, height: 180, channels: 3, background: "black" } }).composite(previews).jpeg({ quality: 85 }).toFile(previewPath);
    return { ...report, previewSample: rows[worst], previewPath, reportPath: path.join(directory, "report.html"), jsonPath: path.join(directory, "report.json") };
}
//# sourceMappingURL=visual.js.map