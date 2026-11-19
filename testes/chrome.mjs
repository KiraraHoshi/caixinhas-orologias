// Abre um Chrome sem janela e fala com ele pelo protocolo DevTools (WebSocket do próprio Node, sem bibliotecas).
// Usado pelos testes (testes/rodar.mjs) e pelos prints da loja (scripts/prints-loja.mjs).
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const espera = (ms) => new Promise((r) => setTimeout(r, ms));
export const CHROMES = [process.env.CX_CHROME, "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "/usr/bin/google-chrome", "/usr/bin/chromium"].filter(Boolean);

// O Chrome escreve a porta e o caminho do DevTools num arquivo do perfil quando termina de subir.
// Num servidor ocupado isso pode demorar: espera até `limite` ms; se não vier, fecha, apaga o perfil e tenta de novo.
// Depois de `tentativas` sem sucesso, lança "o Chrome não abriu" (em vez de um erro de arquivo que não diz nada).
// `antes` vai antes dos argumentos do Chrome (só o teste usa, para fingir um Chrome que não responde).
export async function abrirChrome({ exe = CHROMES.find((c) => existsSync(c)), prefixo = "caixinhas-teste-", limite = 30000, tentativas = 2, extra = [], antes = [] } = {}) {
  if (!exe) throw new Error("o Chrome não abriu: Chrome não encontrado. Defina CX_CHROME com o caminho do executável.");
  const motivos = [];
  for (let n = 1; n <= tentativas; n++) {
    const perfil = await mkdtemp(join(tmpdir(), prefixo));
    const args = ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${perfil}`, "--no-first-run", "--no-default-browser-check", ...(process.platform === "linux" ? ["--no-sandbox"] : []), ...extra, "about:blank"];
    let saiu = null;
    const proc = spawn(exe, [...antes, ...args], { stdio: "ignore" });
    proc.on("exit", (c) => { saiu = c ?? "sinal"; });
    proc.on("error", (e) => { saiu = e.message; });
    const arq = join(perfil, "DevToolsActivePort"), fim = Date.now() + limite;
    let porta = null, caminho = null;
    while (Date.now() < fim && saiu === null) {
      if (existsSync(arq)) {
        try { [porta, caminho] = readFileSync(arq, "utf8").trim().split("\n"); } catch {}
        if (porta && caminho) break; // o arquivo pode existir ainda vazio
      }
      await espera(100);
    }
    if (porta && caminho) {
      try { return await conectar(proc, perfil, porta, caminho); }
      catch (e) { motivos.push(`tentativa ${n}: ${e.message}`); }
    } else motivos.push(`tentativa ${n}: ${saiu !== null ? "o processo terminou (" + saiu + ")" : "sem resposta em " + Math.round(limite / 1000) + " s"}`);
    try { proc.kill(); } catch {}
    await espera(300);
    await rm(perfil, { recursive: true, force: true }).catch(() => {});
  }
  throw new Error(`o Chrome não abriu depois de ${tentativas} tentativas (${motivos.join("; ")})`);
}

async function conectar(proc, perfil, porta, caminho) {
  const ws = new WebSocket(`ws://127.0.0.1:${porta}${caminho}`);
  await new Promise((ok, erro) => { ws.onopen = ok; ws.onerror = () => erro(new Error("o DevTools não aceitou a conexão")); });
  let seq = 0; const pend = new Map(), ouvintes = new Set();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pend.has(m.id)) { const [ok, erro] = pend.get(m.id); pend.delete(m.id); m.error ? erro(new Error(m.error.message)) : ok(m.result); }
    else for (const f of ouvintes) f(m);
  };
  const enviar = (method, params = {}, sessionId) => new Promise((ok, erro) => { const id = ++seq; pend.set(id, [ok, erro]); ws.send(JSON.stringify({ id, method, params, sessionId })); });
  const fechar = async () => { try { ws.close(); } catch {} proc.kill(); await espera(300); await rm(perfil, { recursive: true, force: true }).catch(() => {}); };
  return { enviar, ouvintes, fechar };
}
