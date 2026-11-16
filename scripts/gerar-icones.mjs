// Gera os ícones do Caixinhas a partir de icon-simbolo.svg, com o Chrome do PC (sem dependências).
// Uso: node scripts/gerar-icones.mjs     (defina CX_CHROME se o Chrome estiver em outro lugar)
// Depois de mudar o desenho, suba o ?v= dos ícones em index.html, manifest.webmanifest e sw.js (senão o navegador mostra o antigo).
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const RAIZ = fileURLToPath(new URL("../", import.meta.url));
const CHROME = [process.env.CX_CHROME, "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "/usr/bin/google-chrome", "/usr/bin/chromium"].filter(Boolean).find((c) => existsSync(c));
if (!CHROME) throw new Error("Chrome não encontrado. Defina CX_CHROME.");

const svg = readFileSync(join(RAIZ, "icon-simbolo.svg"), "utf8").replace(/<!--[\s\S]*?-->/g, "");
const miolo = svg.replace(/^[\s\S]*?<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");
const FUNDO = "radial-gradient(70% 70% at 28% 18%, #2A2140 0%, #14111F 72%)"; // o mesmo fundo do ícone do Orolon
const ARQUIVOS = [
  // [caminho, lado, tamanho do símbolo em fração do lado]
  ["icon-192.png", 192, 0.88],
  ["icon-512.png", 512, 0.88],
  ["icon-maskable-512.png", 512, 0.8], // o anel (73% do símbolo) cabe no círculo seguro de 80%
];

const tmp = mkdtempSync(join(tmpdir(), "caixinhas-icones-"));
try {
  for (const [arq, lado, frac] of ARQUIVOS) {
    const pagina = join(tmp, "p.html"), s = Math.round(lado * frac);
    writeFileSync(pagina, `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;width:${lado}px;height:${lado}px;overflow:hidden;background:${FUNDO}}
      div{position:absolute;left:${(lado - s) / 2}px;top:${(lado - s) / 2}px;width:${s}px;height:${s}px}svg{width:100%;height:100%;display:block}</style><body><div>${svg}</div></body>`);
    const r = spawnSync(CHROME, ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=1", `--window-size=${lado},${lado}`,
      `--user-data-dir=${join(tmp, "perfil")}`, `--screenshot=${join(RAIZ, arq)}`, pathToFileURL(pagina).href], { stdio: "ignore" });
    if (r.status !== 0) throw new Error(`Falhou ao gerar ${arq}`);
    console.log("ok", arq, `${lado}x${lado}`);
  }
  // icon.svg: o símbolo já com fundo, para o navegador e o manifesto
  writeFileSync(join(RAIZ, "icon.svg"), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><radialGradient id="f" cx=".28" cy=".18" r=".8"><stop offset="0" stop-color="#2A2140"/><stop offset="1" stop-color="#14111F"/></radialGradient></defs><rect width="100" height="100" rx="22" fill="url(#f)"/><g transform="translate(6 6) scale(.88)">${miolo.trim()}</g></svg>\n`);
  console.log("ok icon.svg");
} finally { rmSync(tmp, { recursive: true, force: true }); }
