// Testes do Caixinhas: abre o app de verdade num Chrome sem janela e confere o que cada teste pede.
// Uso: node testes/rodar.mjs ["parte do nome"]        (prints em testes/prints/)
// Não usa nenhuma biblioteca: fala com o Chrome pelo protocolo DevTools com o WebSocket do próprio Node.
import { createServer } from "node:http";
import { readFile, mkdir, writeFile, mkdtemp, rm } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const RAIZ = fileURLToPath(new URL("../", import.meta.url));
const PRINTS = join(RAIZ, "testes", "prints");
const CHROMES = [process.env.CX_CHROME, "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "/usr/bin/google-chrome", "/usr/bin/chromium"].filter(Boolean);
const TIPOS = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".webmanifest": "application/manifest+json", ".png": "image/png", ".svg": "image/svg+xml" };
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

function servir() {
  const srv = createServer(async (req, res) => {
    let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (p.endsWith("/")) p += "index.html";
    const f = resolve(RAIZ, "." + p);
    if (!f.startsWith(resolve(RAIZ))) { res.writeHead(403); return res.end(); }
    try { const d = await readFile(f); res.writeHead(200, { "content-type": TIPOS[extname(f)] || "application/octet-stream", "cache-control": "no-store" }); res.end(d); }
    catch { res.writeHead(404); res.end(); }
  });
  return new Promise((ok) => srv.listen(0, "127.0.0.1", () => ok(srv)));
}

async function abrirChrome() {
  const exe = CHROMES.find((c) => existsSync(c));
  if (!exe) throw new Error("Chrome não encontrado. Defina CX_CHROME com o caminho do executável.");
  const perfil = await mkdtemp(join(tmpdir(), "caixinhas-teste-"));
  const proc = spawn(exe, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${perfil}`, "--no-first-run", "--no-default-browser-check", "about:blank"], { stdio: "ignore" });
  const arq = join(perfil, "DevToolsActivePort");
  for (let i = 0; i < 100 && !existsSync(arq); i++) await espera(100);
  const [porta, caminho] = readFileSync(arq, "utf8").trim().split("\n");
  const ws = new WebSocket(`ws://127.0.0.1:${porta}${caminho}`);
  await new Promise((ok, erro) => { ws.onopen = ok; ws.onerror = erro; });
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

// Cada teste ganha uma página com armazenamento próprio (começa sempre do zero).
async function novaPagina(cr, base, movimento = false, largura = 360, altura = 780) {
  const { browserContextId } = await cr.enviar("Target.createBrowserContext");
  const { targetId } = await cr.enviar("Target.createTarget", { url: "about:blank", browserContextId });
  const { sessionId } = await cr.enviar("Target.attachToTarget", { targetId, flatten: true });
  const s = (m, p) => cr.enviar(m, p, sessionId);
  const erros = [];
  cr.ouvintes.add((m) => {
    if (m.sessionId !== sessionId) return;
    if (m.method === "Runtime.exceptionThrown") erros.push("exceção: " + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
    if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") erros.push("console.error: " + m.params.args.map((a) => a.value ?? a.description).join(" "));
  });
  await s("Runtime.enable"); await s("Page.enable");
  await s("Emulation.setDeviceMetricsOverride", { width: largura, height: altura, deviceScaleFactor: 1, mobile: true });
  // por padrão os testes rodam com "reduzir movimento" ligado: os valores aparecem prontos, sem esperar animação
  await s("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: movimento ? "no-preference" : "reduce" }] });
  await s("Page.navigate", { url: `${base}/index.html` });
  await espera(700);
  const avaliar = async (fn, ...args) => {
    const r = await s("Runtime.evaluate", { expression: `(${fn})(...${JSON.stringify(args)})`, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error("na página: " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result.value;
  };
  const p = {
    erros, avaliar, espera,
    clicar: async (sel) => { const ok = await avaliar((q) => { const e = document.querySelector(q); if (!e) return false; e.click(); return true; }, sel); if (!ok) throw new Error("não achei para clicar: " + sel); await espera(120); },
    digitar: (sel, txt) => avaliar((q, v) => { const e = document.querySelector(q); e.value = v; e.dispatchEvent(new Event("input", { bubbles: true })); }, sel, txt),
    texto: (sel) => avaliar((q) => { const e = document.querySelector(q); return e ? e.textContent.replace(/\s+/g, " ").trim() : null; }, sel),
    visivel: (sel) => avaliar((q) => { const e = document.querySelector(q); if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== "hidden"; }, sel),
    recarregar: async () => { await avaliar(() => { location.reload(); }).catch(() => {}); await espera(700); },
    aba: async (t) => { await avaliar((x) => { location.hash = "#" + x; }, t); await espera(200); },
    abaAtual: () => avaliar(() => [...document.querySelectorAll(".view")].find((v) => !v.hidden).id.slice(2)),
    tamanho: (w, h) => s("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: true }),
    print: async (nome, inteira) => {
      await mkdir(PRINTS, { recursive: true });
      const d = await s("Page.captureScreenshot", { format: "png", captureBeyondViewport: !!inteira });
      await writeFile(join(PRINTS, nome + ".png"), Buffer.from(d.data, "base64"));
    },
    fechar: () => cr.enviar("Target.disposeBrowserContext", { browserContextId }),
  };
  return p;
}

const igual = (a, b, msg) => { if (a !== b) throw new Error(`${msg}: esperava ${JSON.stringify(b)}, veio ${JSON.stringify(a)}`); };
const certo = (v, msg) => { if (!v) throw new Error(msg); };
const lancar = async (p, valor, oQue) => { await p.clicar("#fab"); await p.digitar("#gValor", String(valor)); await p.digitar("#gDesc", oQue); await p.clicar("#gBtn"); };
const calc = async (p, qual) => { await p.aba("calc"); await p.clicar('[data-calc="' + qual + '"]'); };
const animando = (p) => p.avaliar(() => document.getAnimations().filter((a) => a.playState === "running").length);
// aporta na meta cujo cartão contém o nome dado
const aportar = (p, nome, valor) => p.avaliar((nome, valor) => { const c = [...document.querySelectorAll("#metasLista .meta-card")].find((x) => x.textContent.includes(nome)); c.querySelector("input").value = valor; c.querySelector('[data-act="meta-aportar"]').click(); }, nome, String(valor));
const cartaoMeta = (p, nome) => p.avaliar((nome) => { const c = [...document.querySelectorAll("#metasLista .meta-card")].find((x) => x.textContent.includes(nome)); return c ? c.textContent.replace(/\s+/g, " ") : ""; }, nome);
const comExemplo = async (p) => { await p.clicar('[data-act="onb-exemplo"]'); await p.espera(200); };

const TESTES = {
  "primeira abertura mostra as boas-vindas e o botão Lançar": async (p) => {
    certo(await p.visivel("#inOnb .onb"), "boas-vindas não apareceram");
    certo(await p.visivel("#fab"), "botão Lançar não apareceu");
    certo(!(await p.visivel("#folhaGasto")), "a folha não devia abrir sozinha");
    await p.print("01-primeira-abertura");
  },
  "Início mostra a sobra, o mostrador e as caixinhas com ícone": async (p) => {
    await comExemplo(p);
    igual(await p.texto("#inResumo .big"), "R$ 1.230,70", "sobra do mês");
    certo(await p.visivel("#inResumo .dial"), "mostrador não apareceu");
    igual(await p.avaliar(() => document.querySelectorAll("#inCx .cxl .cxi svg").length), 3, "caixinhas com ícone no Início");
    await p.print("02-inicio", true);
  },
  "Lançar pelo botão fixo, sem sair do Início": async (p) => {
    await comExemplo(p);
    await p.clicar("#fab");
    certo(await p.visivel("#folhaGasto"), "a folha não abriu");
    await p.digitar("#gValor", "50");
    igual(await p.texto("#gPrev"), "Cabe. Lazer fica com R$ 470,10.", "aviso de cabe");
    await p.print("03-folha-lancar");
    await p.digitar("#gDesc", "Cinema");
    await p.clicar("#gBtn");
    await p.espera(200);
    certo(!(await p.visivel("#folhaGasto")), "a folha devia fechar depois de lançar");
    igual(await p.abaAtual(), "inicio", "aba depois de lançar");
    igual(await p.texto("#inResumo .big"), "R$ 1.180,70", "sobra depois do gasto");
    certo(await p.visivel("#fab"), "botão Lançar devia voltar");
  },
  "Não cabe: avisa em quanto estoura": async (p) => {
    await comExemplo(p);
    await p.clicar("#fab");
    await p.digitar("#gValor", "600");
    igual(await p.texto("#gPrev"), "Não cabe: Lazer estoura em R$ 79,90. Dá para remanejar de outra caixinha.", "aviso de não cabe");
  },
  "Editar abre a mesma folha e Esc cancela": async (p) => {
    await comExemplo(p);
    await p.aba("mes");
    await p.clicar('[data-act="ed-gasto"]');
    certo(await p.visivel("#folhaGasto"), "a folha não abriu para editar");
    igual(await p.texto("#gHead"), "Editar gasto", "título da folha");
    await p.avaliar(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    await p.espera(150);
    certo(!(await p.visivel("#folhaGasto")), "Esc devia fechar");
    igual(await p.texto("#gHead"), "Lançar gasto", "a edição devia ser cancelada");
    igual(await p.abaAtual(), "mes", "aba depois de cancelar");
    await p.print("04-mes", true);
  },
  "Voltar do aparelho fecha só a folha": async (p) => {
    await comExemplo(p);
    await p.aba("cartao");
    await p.clicar("#fab");
    await p.avaliar(() => history.back());
    await p.espera(250);
    certo(!(await p.visivel("#folhaGasto")), "voltar devia fechar a folha");
    igual(await p.abaAtual(), "cartao", "voltar não devia trocar de aba");
    await p.clicar("#fab");
    await p.clicar('.folha-topo [data-act="folha-fechar"]');
    await p.espera(250);
    igual(await p.abaAtual(), "cartao", "fechar no × não devia trocar de aba");
  },
  "Barra com 5 abas e Calculadoras pelo Início": async (p) => {
    await comExemplo(p);
    igual(await p.avaliar(() => document.querySelectorAll(".tabs a").length), 5, "abas na barra");
    await p.clicar('.atalho[data-go="calc"]');
    igual(await p.abaAtual(), "calc", "atalho das calculadoras");
    igual(await p.avaliar(() => document.querySelector('.tabs a[aria-current="page"]').dataset.tab), "inicio", "aba acesa nas calculadoras");
    await p.clicar('#v-calc [data-go="inicio"]');
    igual(await p.abaAtual(), "inicio", "voltar ao Início");
  },
  "Ícone escolhido em Ajustes fica salvo": async (p) => {
    await comExemplo(p);
    await p.aba("ajustes");
    await p.clicar('[data-act="cx-ico"][data-i="0"][data-ico="pet"]');
    await p.print("05-ajustes-caixinhas");
    await p.clicar('[data-act="cx-save"]');
    igual(await p.avaliar(() => JSON.parse(localStorage.getItem("caixinhas-orologia-v1")).caixinhas[0].icone), "pet", "ícone salvo");
  },
  "Cópia automática neste aparelho desfaz um apagar tudo": async (p) => {
    await p.clicar('[data-act="onb-skip"]');
    await p.clicar("#fab"); await p.digitar("#gValor", "50"); await p.digitar("#gDesc", "Cinema"); await p.clicar("#gBtn");
    await p.espera(1900);
    await p.aba("ajustes");
    igual(await p.texto("#bkpCopias summary"), "Cópias neste aparelho (1)", "cópia do dia");
    await p.clicar('[data-act="wipe"]'); await p.clicar('[data-act="wipe"]');
    await p.espera(400);
    igual(await p.avaliar(() => Object.keys(JSON.parse(localStorage.getItem("caixinhas-orologia-v1")).meses).length), 0, "dados depois de apagar tudo");
    igual(await p.texto("#bkpCopias summary"), "Cópias neste aparelho (2)", "cópia de antes de apagar");
    certo((await p.texto("#bkpCopias .copia span")).startsWith("Antes de apagar tudo"), "a cópia mais recente devia ser a de antes de apagar");
    await p.avaliar(() => { document.querySelector("#bkpCopias").open = true; document.querySelector("#bkpBox").scrollIntoView(); });
    await p.espera(3600); // deixa o aviso sumir da frente
    await p.print("06-backup");
    await p.clicar('[data-act="bkp-rest"]');
    await p.clicar('[data-act="imp-ok"]');
    igual(await p.avaliar(() => Object.values(JSON.parse(localStorage.getItem("caixinhas-orologia-v1")).meses)[0].gastos[0].descricao), "Cinema", "gasto de volta depois de restaurar");
  },
  "Backup automático grava um arquivo por dia na pasta escolhida": async (p) => {
    // a janela de escolher pasta não abre sem pessoa: usamos a pasta particular do navegador, que tem os mesmos comandos
    await p.avaliar(() => { window.showDirectoryPicker = () => navigator.storage.getDirectory(); });
    await p.clicar('[data-act="onb-skip"]');
    await p.clicar("#fab"); await p.digitar("#gValor", "50"); await p.digitar("#gDesc", "Cinema"); await p.clicar("#gBtn");
    await p.aba("ajustes");
    await p.clicar('[data-act="bkp-pasta"]');
    await p.espera(600);
    const hoje = await p.avaliar(() => { const d = new Date(); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); });
    const ler = () => p.avaliar(async (nome) => { const d = await navigator.storage.getDirectory(); try { return await (await (await d.getFileHandle(nome)).getFile()).text(); } catch (e) { return null; } }, "caixinhas-backup-" + hoje + ".json");
    certo((await ler() || "").includes("Cinema"), "o arquivo do dia não foi gravado na pasta");
    certo((await p.texto("#bkpBox")).includes("Gravando na pasta"), "o estado da pasta não apareceu");
    await p.clicar("#fab"); await p.digitar("#gValor", "20"); await p.digitar("#gDesc", "Pipoca"); await p.clicar("#gBtn");
    await p.espera(1900);
    certo((await ler() || "").includes("Pipoca"), "o arquivo não foi atualizado depois de um novo gasto");
    // arquivos antigos: sobram só os 7 mais recentes
    await p.avaliar(async () => { const d = await navigator.storage.getDirectory(); for (let i = 1; i <= 9; i++) { const w = await (await d.getFileHandle("caixinhas-backup-2020-01-0" + i + ".json", { create: true })).createWritable(); await w.write("{}"); await w.close(); } });
    await p.clicar("#fab"); await p.digitar("#gValor", "5"); await p.digitar("#gDesc", "Bala"); await p.clicar("#gBtn");
    await p.espera(1900);
    igual(await p.avaliar(async () => { const d = await navigator.storage.getDirectory(); let n = 0; for await (const k of d.keys()) if (k.startsWith("caixinhas-backup-")) n++; return n; }), 7, "arquivos de backup na pasta");
  },
  "Abertura longa toca uma vez por dia": { movimento: true, fn: async (p) => {
    await comExemplo(p);
    await p.espera(2200);
    igual(await p.avaliar(() => document.querySelector("#inResumo").dataset.abertura), "longa", "primeira abertura do dia");
    igual(await p.texto("#inResumo .big"), "R$ 1.230,70", "sobra ao fim da abertura longa");
    await p.recarregar(); await p.espera(1000);
    igual(await p.avaliar(() => document.querySelector("#inResumo").dataset.abertura), "curta", "segunda abertura do dia");
    igual(await p.texto("#inResumo .big"), "R$ 1.230,70", "sobra ao fim da abertura curta");
  } },
  "Durante a abertura a sobra conta até o valor": { movimento: true, fn: async (p) => {
    await comExemplo(p);
    await p.avaliar(() => { localStorage.removeItem("caixinhas-orologia-abertura"); location.reload(); }).catch(() => {});
    let contou = false;
    for (let i = 0; i < 24 && !contou; i++) { await p.espera(50); const v = await p.texto("#inResumo .big").catch(() => null); if (v && v !== "R$ 1.230,70") contou = true; }
    certo(contou, "a sobra apareceu pronta, sem contar");
    await p.espera(2200);
    igual(await p.texto("#inResumo .big"), "R$ 1.230,70", "sobra ao fim da contagem");
    igual(await p.avaliar(() => document.querySelectorAll("#inCx .cxl").length), 3, "caixinhas no Início");
  } },
  "Início se refaz quando as caixinhas mudam": async (p) => {
    await comExemplo(p);
    await p.aba("ajustes");
    await p.clicar('[data-act="cx-add"]'); await p.clicar('[data-act="cx-save"]');
    await p.aba("inicio");
    igual(await p.avaliar(() => document.querySelectorAll("#inCx .cxl").length), 4, "caixinhas no Início depois de criar uma");
    igual(await p.texto("#inResumo .big"), "R$ 1.230,70", "sobra não muda com caixinha sem limite");
  },
  "Com PIN, a abertura espera o desbloqueio": { movimento: true, fn: async (p) => {
    await comExemplo(p);
    await p.aba("ajustes");
    await p.digitar("#pinNovo", "1234"); await p.digitar("#pinRep", "1234"); await p.clicar('[data-pin="ativar"]');
    await p.aba("inicio"); // o endereço guarda a aba; a abertura só toca com o Início à vista
    await p.avaliar(() => { localStorage.removeItem("caixinhas-orologia-abertura"); location.reload(); }).catch(() => {});
    await p.espera(1500);
    igual(await p.avaliar(() => document.querySelector("#inResumo").dataset.abertura || ""), "", "a abertura não devia tocar atrás do bloqueio");
    for (const n of "1234") await p.clicar('[data-tk="' + n + '"]');
    await p.espera(300);
    igual(await p.avaliar(() => document.querySelector("#inResumo").dataset.abertura), "longa", "abertura depois de desbloquear");
    await p.espera(2200);
    igual(await p.texto("#inResumo .big"), "R$ 1.230,70", "sobra depois de desbloquear");
  } },
  "Início no tema claro": async (p) => {
    await comExemplo(p);
    await p.aba("ajustes");
    await p.avaliar(() => document.querySelectorAll('[data-tm="usar"]')[1].click());
    await p.aba("inicio"); await p.espera(3600);
    igual(await p.texto("#inResumo .big"), "R$ 1.230,70", "sobra no tema claro");
    await p.print("07-inicio-claro");
  },
  "Mostrador aguenta caixinha sem limite": async (p) => {
    const semear = (comGasto) => p.avaliar((comGasto) => {
      const d = new Date(), mes = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
      localStorage.setItem("caixinhas-orologia-v1", JSON.stringify({ onboarded: true, caixinhas: [{ id: "a", nome: "Avulsos", cor: "#9C9BF5" }, { id: "b", nome: "Outra", cor: "#E3C98A" }], limitesPadrao: { a: 0, b: 0 },
        meses: comGasto ? { [mes]: { gastos: [{ id: "g1", valor: 30, descricao: "Pão", caixinha: "a", forma: "Pix", data: mes + "-01" }] } } : {} }));
    }, comGasto);
    for (const comGasto of [true, false]) {
      await semear(comGasto); await p.recarregar();
      const ruim = await p.avaliar(() => [...document.querySelectorAll("#inResumo .dial, #inResumo .dial *")].flatMap((e) => [...e.attributes].map((a) => a.value)).filter((v) => /NaN|undefined|Infinity/.test(v)));
      igual(ruim.length, 0, "atributos quebrados no mostrador (" + (comGasto ? "com" : "sem") + " gasto): " + ruim.join(" | "));
      igual(await p.texto("#inResumo .big"), comGasto ? "-R$ 30,00" : "R$ 0,00", "sobra sem limite");
    }
  },
  "Estourou: mostra quanto passou": async (p) => {
    await comExemplo(p);
    await lancar(p, 600, "Viagem de fim de semana");
    certo((await p.texto('#inCx .cxl[data-cx="lazer"]')).includes("passou R$ 79,90"), "a caixinha estourada devia dizer quanto passou: " + await p.texto('#inCx .cxl[data-cx="lazer"]'));
    igual(await p.texto('#inCx .cxl[data-cx="diaadia"] small'), "", "caixinha dentro do limite não tem aviso");
  },
  "Lançar no Início faz o mostrador reagir": { movimento: true, fn: async (p) => {
    await comExemplo(p); await p.espera(2300);
    await lancar(p, 50, "Cinema");
    certo((await animando(p)) > 0, "nada se moveu depois de lançar");
    igual(await p.texto("#inResumo .ficha"), "− R$ 50,00", "valor lançado no centro do mostrador");
    await p.espera(1500);
    igual(await animando(p), 0, "animações que não terminaram");
    igual(await p.texto("#inResumo .big"), "R$ 1.180,70", "sobra depois de lançar");
  } },
  "Lançar no Mês faz a barra da caixinha reagir": { movimento: true, fn: async (p) => {
    await comExemplo(p); await p.aba("mes");
    await lancar(p, 50, "Cinema");
    certo((await p.avaliar(() => document.querySelector('#mesBoxes .box[data-cx="lazer"] .bar i').getAnimations().length)) > 0, "a barra do Lazer não se moveu");
    await p.espera(1200);
    igual(await animando(p), 0, "animações que não terminaram");
  } },
  "Lançar no meio da abertura termina no valor certo": { movimento: true, fn: async (p) => {
    await comExemplo(p);
    await p.avaliar(() => { localStorage.removeItem("caixinhas-orologia-abertura"); location.reload(); }).catch(() => {});
    await p.espera(350);
    await lancar(p, 50, "Cinema");
    await p.espera(2500);
    igual(await p.texto("#inResumo .big"), "R$ 1.180,70", "sobra depois de lançar durante a abertura");
    igual(await p.texto('#inCx .cxl[data-cx="lazer"] .v'), "R$ 470,10", "sobra do Lazer");
  } },
  "Abertura curta: só o anel e as barras contam, os números já vêm certos": { movimento: true, fn: async (p) => {
    await comExemplo(p); await p.espera(2200); // a longa do dia já tocou
    await p.avaliar(() => { location.reload(); }).catch(() => {});
    const vistos = [];
    for (let i = 0; i < 12; i++) { await p.espera(30); const v = await p.avaliar(() => { const b = document.querySelector("#inResumo .big"), l = document.querySelector('#inCx .cxl[data-cx="lazer"] .v'); return b && l && b.textContent ? (b.textContent + " | " + l.textContent).replace(/\s/g, " ") : null; }).catch(() => null); if (v) vistos.push(v); }
    certo(vistos.length >= 3, "poucas amostras: " + vistos.length);
    const errados = vistos.filter((v) => v !== "R$ 1.230,70 | R$ 520,10");
    igual(errados.length, 0, "números que contaram na abertura curta: " + errados.slice(0, 3).join(" ; "));
  } },
  "Sobra grande não muda de tamanho durante a contagem": { movimento: true, fn: async (p) => {
    await p.avaliar(() => {
      const d = new Date(), mes = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
      localStorage.setItem("caixinhas-orologia-v1", JSON.stringify({ onboarded: true, caixinhas: [{ id: "a", nome: "Tudo", cor: "#9C9BF5" }], limitesPadrao: { a: 100000 },
        meses: { [mes]: { gastos: [{ id: "g1", valor: 99995, descricao: "Carro", caixinha: "a", forma: "Pix", data: mes + "-01" }] } } }));
      localStorage.removeItem("caixinhas-orologia-abertura"); location.reload();
    }).catch(() => {});
    const classes = new Set();
    for (let i = 0; i < 40; i++) { await p.espera(40); const c = await p.avaliar(() => { const b = document.querySelector("#inResumo .big"); return b && b.textContent ? String(b.classList.contains("longo")) : null; }).catch(() => null); if (c) classes.add(c); }
    igual(classes.size, 1, "o tamanho do número mudou durante a contagem: " + [...classes].join(","));
    igual(await p.texto("#inResumo .big"), "R$ 5,00", "sobra no fim");
  } },
  "Aviso 'passou R$' aparece inteiro mesmo com nome comprido": async (p) => {
    await p.avaliar(() => {
      const d = new Date(), mes = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
      localStorage.setItem("caixinhas-orologia-v1", JSON.stringify({ onboarded: true, caixinhas: [{ id: "a", nome: "Mercado e padaria do bairro", cor: "#9C9BF5" }], limitesPadrao: { a: 100 },
        meses: { [mes]: { gastos: [{ id: "g1", valor: 250, descricao: "Compras", caixinha: "a", forma: "Pix", data: mes + "-01" }] } } }));
    });
    await p.tamanho(320, 640); await p.recarregar(); await p.espera(1500);
    const m = await p.avaliar(() => { const b = document.querySelector("#inCx .cxl b"), s = b.querySelector("small"), r = s.getBoundingClientRect(), rb = b.getBoundingClientRect(); return { texto: s.textContent, dentro: r.right <= rb.right + 1 && r.width > 0, nomeCortado: b.scrollWidth > b.clientWidth + 1 }; });
    igual(m.texto.replace(/\s/g, " "), "passou R$ 150,00", "texto do aviso");
    certo(m.dentro, "o aviso 'passou' ficou fora da área visível da linha");
    igual(m.nomeCortado, false, "a linha inteira estourou a largura");
  },
  "Gastar além do limite durante a abertura não corta o giro": { movimento: true, fn: async (p) => {
    await comExemplo(p);
    await p.avaliar(() => {
      localStorage.removeItem("caixinhas-orologia-abertura");
      window.__fio = () => parseFloat(document.querySelector('#inResumo [data-d="fio"]').getAttribute("stroke-dasharray"));
      location.reload();
    }).catch(() => {});
    await p.espera(120);
    await p.avaliar(() => {
      window.__fio = () => parseFloat(document.querySelector('#inResumo [data-d="fio"]').getAttribute("stroke-dasharray"));
      document.addEventListener("click", (e) => { if (e.target.closest && e.target.closest("#gBtn")) { window.__antes = window.__fio(); setTimeout(() => { window.__depois = window.__fio(); }, 40); } }, true);
    });
    await lancar(p, 600, "Viagem");
    await p.espera(2500);
    const f = await p.avaliar(() => ({ antes: window.__antes, depois: window.__depois, fim: window.__fio() }));
    certo(f.antes < f.fim * 0.9, "o teste chegou tarde: o fio já estava em " + f.antes + " de " + f.fim);
    certo(f.depois - f.antes < f.fim * 0.15, "o fio saltou de " + f.antes + " para " + f.depois + " (fim " + f.fim + ")");
  } },
  "Lançamentos seguidos não se atropelam": { movimento: true, fn: async (p) => {
    await comExemplo(p);
    await lancar(p, 10, "Um"); await lancar(p, 20, "Dois"); await lancar(p, 30, "Três");
    await p.espera(1600);
    igual(await p.texto("#inResumo .big"), "R$ 1.170,70", "sobra depois de três lançamentos");
    igual(await animando(p), 0, "animações que não terminaram");
  } },
  "Meta batida aparece como batida": async (p) => {
    await comExemplo(p); await p.aba("metas");
    certo(!(await cartaoMeta(p, "Viagem")).includes("Meta batida"), "a meta ainda não foi batida");
    await aportar(p, "Viagem", 2500); await p.espera(200);
    certo((await cartaoMeta(p, "Viagem")).includes("Meta batida"), "o cartão devia dizer Meta batida: " + await cartaoMeta(p, "Viagem"));
    igual(await p.avaliar(() => document.querySelectorAll(".faisca").length), 0, "faíscas com movimento desligado");
    await p.aba("inicio"); await p.aba("metas");
    certo((await cartaoMeta(p, "Viagem")).includes("Meta batida"), "continua batida ao reabrir a tela");
  },
  "Meta batida solta faíscas e limpa depois": { movimento: true, fn: async (p) => {
    await comExemplo(p); await p.aba("metas");
    await aportar(p, "Viagem", 2500);
    await p.espera(1150);
    certo((await p.avaliar(() => document.querySelectorAll(".faisca").length)) > 0, "nenhuma faísca saiu quando a barra completou");
    await p.espera(1700);
    igual(await p.avaliar(() => document.querySelectorAll(".faisca").length), 0, "faíscas que ficaram na tela");
    igual(await animando(p), 0, "animações que não terminaram");
    await aportar(p, "Viagem", 10); await p.espera(1300);
    igual(await p.avaliar(() => document.querySelectorAll(".faisca").length), 0, "não comemora de novo uma meta que já estava batida");
  } },
  "Gráfico de faturas anima ao entrar e termina igual": { movimento: true, fn: async (p) => {
    await comExemplo(p); await p.aba("cartao");
    const nasBarras = () => p.avaliar(() => [...document.querySelectorAll("#cartProj .gb")].reduce((a, g) => a + g.getAnimations().length, 0));
    certo((await nasBarras()) > 0, "as barras das próximas faturas não se moveram");
    await p.espera(1700);
    igual(await nasBarras(), 0, "animações que não terminaram");
    const alturas = await p.avaliar(() => [...document.querySelectorAll("#cartProj .gb")].map((g) => Math.round(g.getBoundingClientRect().height)));
    certo(alturas.length === 6 && alturas.every((h) => h > 0), "barras sem altura no fim: " + alturas.join(","));
  } },
  "Simulador se desenha ao entrar, mas não a cada tecla": { movimento: true, fn: async (p) => {
    await comExemplo(p); await calc(p, "sim");
    const naCurva = () => p.avaliar(() => [...document.querySelectorAll("#simChart .ga-tot, #simChart .ga-bola")].reduce((a, g) => a + g.getAnimations().length, 0));
    certo((await naCurva()) > 0, "a curva do simulador não se desenhou");
    await p.espera(2000);
    igual(await naCurva(), 0, "animações que não terminaram");
    await p.digitar("#simAnos", "8"); await p.espera(100);
    igual(await naCurva(), 0, "mudar um campo não devia animar de novo");
  } },
  "Gráfico do mês anima ao abrir a seção": { movimento: true, fn: async (p) => {
    await comExemplo(p); await p.aba("mes");
    await p.clicar("#dGraf summary"); await p.espera(60);
    certo((await p.avaliar(() => [...document.querySelectorAll("#grafBox .gb")].reduce((a, g) => a + g.getAnimations().length, 0))) > 0, "as barras dos 6 meses não se moveram");
  } },
  "Cartões: avisa que não se digita dado do cartão": async (p) => {
    await p.aba("cartao");
    certo((await p.texto("#ktAviso")).includes("nunca pede número, validade nem código de segurança"), "faltou o aviso no cadastro de cartões");
    certo((await p.texto('label:has(#ktNome)')).startsWith("Apelido do cartão"), "o campo devia pedir um apelido");
    await p.aba("ajustes");
    certo((await p.texto("#bkpDica")).includes("Crie uma pasta só para isso"), "faltou a dica de criar uma pasta para o backup");
  },
  "Leitor de tela ouve os valores atuais no Início": async (p) => {
    await comExemplo(p);
    const rotulo = () => p.avaliar(() => document.querySelector('#inCx .cxl[data-cx="lazer"]').getAttribute("aria-label").replace(/\s+/g, " "));
    igual(await rotulo(), "Lazer: sobra R$ 520,10 de R$ 700,00", "rótulo do Lazer");
    const dial = await p.avaliar(() => document.querySelector("#inResumo .dial").getAttribute("aria-label"));
    certo(/^18% do limite do mês gasto, com \d+% do mês passado$/.test(dial), "rótulo do mostrador: " + dial);
    await lancar(p, 50, "Cinema");
    igual(await rotulo(), "Lazer: sobra R$ 470,10 de R$ 700,00", "rótulo do Lazer depois de lançar");
  },
  "Gasto de caixinha que não existe mais entra e sai da sobra": async (p) => {
    await p.avaliar(() => {
      const d = new Date(), mes = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
      localStorage.setItem("caixinhas-orologia-v1", JSON.stringify({ onboarded: true, caixinhas: [{ id: "a", nome: "Casa", cor: "#9C9BF5" }], limitesPadrao: { a: 1000 },
        meses: { [mes]: { gastos: [{ id: "g1", valor: 50, descricao: "Luz", caixinha: "a", forma: "Pix", data: mes + "-01" }, { id: "g2", valor: 100, descricao: "Antigo", caixinha: "fantasma", forma: "Pix", data: mes + "-02" }] } } }));
    });
    await p.recarregar();
    igual(await p.texto("#inResumo .big"), "R$ 850,00", "sobra com o gasto órfão");
    await p.aba("mes");
    await p.clicar('[data-act="del-gasto"][data-id="g2"]'); await p.clicar('[data-act="del-gasto"][data-id="g2"]');
    await p.aba("inicio");
    igual(await p.texto("#inResumo .big"), "R$ 950,00", "sobra depois de apagar o gasto órfão");
  },
  "Abrir em outra aba não gasta a abertura longa": { movimento: true, fn: async (p) => {
    await comExemplo(p); await p.aba("mes");
    await p.avaliar(() => { localStorage.removeItem("caixinhas-orologia-abertura"); location.reload(); }).catch(() => {});
    await p.espera(900);
    igual(await p.abaAtual(), "mes", "o app reabre na aba Mês");
    igual(await p.avaliar(() => localStorage.getItem("caixinhas-orologia-abertura")), null, "a abertura longa não devia ser gasta fora do Início");
    await p.aba("inicio"); await p.espera(150);
    igual(await p.avaliar(() => document.querySelector("#inResumo").dataset.abertura), "longa", "a longa toca quando o Início aparece");
  } },
  "Caixas de marcar mostram o texto em linha, sem espremer": async (p) => {
    await comExemplo(p);
    await p.tamanho(700, 900);
    for (const [aba, id] of [["calc", "simIR"], ["mes", "fTodos"], ["cartao", "cAss"]]) {
      await p.aba(aba); if (aba === "calc") await p.clicar('[data-calc="sim"]');
      const m = await p.avaliar((id) => { const e = document.getElementById(id); if (!e) return null; const r = e.closest("label").getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; }, id);
      certo(m, "não achei a caixa " + id);
      certo(m.w > 150 && m.h < 60, "o texto da caixa " + id + " está espremido: " + m.w + "x" + m.h);
    }
    await calc(p, "sim");
    const fora = await p.avaliar(() => { const s = document.querySelector("#simChart svg").getBoundingClientRect(); return [...document.querySelectorAll("#simChart svg text")].filter((x) => { const r = x.getBoundingClientRect(); return r.right > s.right + 0.5 || r.left < s.left - 0.5; }).map((x) => x.textContent); });
    igual(fora.join(","), "", "textos do gráfico cortados na borda");
    await p.avaliar(() => document.querySelector("#fSim").scrollIntoView()); await p.espera(3600);
    await p.print("08-simulador-largo");
  },
  "Ícone da aba aponta para o ícone novo, com a versão no endereço": async (p) => {
    const r = await p.avaliar(async () => {
      const ls = [...document.querySelectorAll('link[rel~="icon"], link[rel="apple-touch-icon"]')].map((l) => l.getAttribute("href"));
      const svg = await (await fetch(document.querySelector('link[rel="icon"][type="image/svg+xml"]').href)).text();
      return { ls, novo: svg.includes("radialGradient") && !svg.includes("stroke-linecap=\"round\"/><line") };
    });
    certo(r.ls.length >= 2 && r.ls.every((h) => /\?v=\d+$/.test(h)), "os ícones devem ter a revisão (?v=) no endereço: " + r.ls.join(" | "));
    certo(r.novo, "o icon.svg servido não é o ícone novo");
  },
  "Sem movimento: nada anima": async (p) => {
    await comExemplo(p);
    igual(await p.texto("#inResumo .big"), "R$ 1.230,70", "sobra pronta, sem contar");
    for (const t of ["inicio", "cartao", "metas", "mes"]) {
      await p.aba(t); if (t === "mes") await p.clicar("#dGraf summary");
      igual(await p.avaliar(() => document.getAnimations().filter((a) => !a.animationName || !a.animationName.startsWith("fl-")).length), 0, "animações na aba " + t);
    }
  },
  "Calculadoras: financiamento compara SAC e PRICE": async (p) => {
    await comExemplo(p); await calc(p, "fin");
    igual(await p.texto("#v-calc .eyebrow"), "Calculadoras", "nome da tela");
    // 12,682503% ao ano = 1% ao mês; R$ 200.000 em 240 meses
    await p.digitar("#iValor", "250000"); await p.digitar("#iEntrada", "50000"); await p.digitar("#iJuros", "12,682503"); await p.digitar("#iAnos", "20");
    await p.digitar("#iCorr", "0"); await p.digitar("#iRenda", ""); await p.digitar("#iExtra", "");
    const sac = await p.texto("#finSac"), price = await p.texto("#finPrice");
    certo(sac.includes("R$ 2.833,33") && sac.includes("R$ 841,67") && sac.includes("R$ 441.000,00") && sac.includes("20 anos"), "SAC: " + sac);
    certo(price.includes("R$ 2.202,17") && price.includes("R$ 528.521,") && price.includes("20 anos"), "PRICE: " + price);
    igual(await p.texto("#finAviso"), "", "sem renda não há aviso");
    await p.digitar("#iRenda", "5000");
    certo((await p.texto("#finAviso")).includes("57% no SAC"), "aviso de parcela acima de 30% da renda: " + await p.texto("#finAviso"));
    await p.digitar("#iRenda", "20000");
    igual(await p.texto("#finAviso"), "", "parcela dentro de 30% da renda não avisa");
    await p.digitar("#iExtra", "500");
    const sac2 = await p.texto("#finSac");
    certo(!sac2.includes("20 anos") && sac2.includes("economiza"), "amortização extra devia encurtar o prazo e dizer a economia: " + sac2);
    certo((await p.texto("#finPrice")).includes("economiza"), "PRICE com extra: " + await p.texto("#finPrice"));
    await p.digitar("#iValor", "0"); // entradas vazias ou absurdas não quebram a conta
    certo(!/NaN|Infinity|undefined/.test(await p.texto("#c-fin")), "conta quebrada: " + await p.texto("#c-fin"));
    await p.digitar("#iValor", "250000"); await p.digitar("#iJuros", "0"); await p.digitar("#iExtra", "");
    certo((await p.texto("#finPrice")).includes("R$ 833,33"), "sem juros a parcela é o valor dividido pelo prazo: " + await p.texto("#finPrice"));
    await p.print("12-financiamento");
    await p.tamanho(900, 800); await p.espera(150); await p.print("12-financiamento-pc");
    const sobra = await p.avaliar(() => document.documentElement.scrollWidth - window.innerWidth);
    certo(sobra <= 0, "a tela passa " + sobra + "px da largura no PC");
  },
  "Financiamento com correção: a parcela acompanha o índice e a dívida fecha no prazo": async (p) => {
    await comExemplo(p); await calc(p, "fin");
    await p.digitar("#iValor", "250000"); await p.digitar("#iEntrada", "50000"); await p.digitar("#iJuros", "12,682503"); await p.digitar("#iAnos", "20");
    await p.digitar("#iCorr", "5"); await p.digitar("#iRenda", ""); await p.digitar("#iExtra", "");
    const sac = await p.texto("#finSac"), price = await p.texto("#finPrice");
    certo(sac.includes("20 anos") && price.includes("20 anos"), "com correção e sem extra o prazo continua o contratado: " + sac + " | " + price);
    certo(!sac.includes("R$ 441.000,00"), "a correção devia aumentar o total pago: " + sac);
  },
  "Simuladores ficam em Calculadoras e Metas leva até eles": async (p) => {
    await comExemplo(p); await p.aba("metas");
    igual(await p.avaliar(() => !!document.querySelector("#v-metas #simChart, #v-metas #fPmt")), false, "os simuladores ainda estão em Metas");
    await p.clicar('#v-metas [data-act="simular"]');
    igual(await p.abaAtual(), "calc", "o atalho abre Calculadoras");
    certo(await p.visivel("#simChart svg"), "o simulador de juros devia estar à vista");
    certo((await p.texto("#simOut")).includes("Total em 5 anos"), "resultado do simulador: " + await p.texto("#simOut"));
    await p.clicar('[data-calc="pmt"]');
    certo((await p.texto("#pmtOut")).includes("Guardar por mês"), "quanto guardar: " + await p.texto("#pmtOut"));
    igual(await p.visivel("#simChart svg"), false, "só uma calculadora por vez");
  },
  "Mês mostra os 8 lançamentos mais recentes e o resto a pedido": async (p) => {
    await comExemplo(p);
    for (let i = 1; i <= 9; i++) await lancar(p, i, "Teste " + i);
    await p.aba("mes");
    const itens = () => p.avaliar(() => document.querySelectorAll("#mesLista .item").length);
    const total = await p.avaliar(() => { const d = new Date(), k = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0"); return JSON.parse(localStorage.getItem("caixinhas-orologia-v1")).meses[k].gastos.length; });
    certo(total > 8, "o exemplo devia ter mais de 8 gastos: " + total);
    igual(await itens(), 8, "lançamentos à vista");
    certo((await p.texto("#mesLista")).includes("Teste 9"), "os mais recentes ficam à vista");
    igual(await p.texto('[data-act="lista-toda"]'), "Mostrar todos (" + total + ")", "botão de mostrar todos");
    await p.digitar("#fBusca", "Teste"); await p.espera(100);
    igual(await itens(), 9, "a busca mostra todos os resultados");
    await p.digitar("#fBusca", ""); await p.espera(100);
    await p.clicar('[data-act="lista-toda"]');
    igual(await itens(), total, "todos os lançamentos depois de pedir");
    igual(await p.texto('[data-act="lista-toda"]'), "Mostrar só os mais recentes", "botão de recolher");
    await p.aba("inicio"); await p.aba("mes");
    igual(await itens(), 8, "ao voltar para a tela, a lista está curta de novo");
  },
  "Nenhuma tela passa da largura em celular estreito": async (p) => {
    await comExemplo(p);
    await p.tamanho(320, 640);
    for (const t of ["inicio", "mes", "cartao", "metas", "calc", "ajustes", "guia"]) {
      await p.aba(t);
      const sobra = await p.avaliar(() => document.documentElement.scrollWidth - window.innerWidth);
      certo(sobra <= 0, `a aba ${t} passa ${sobra}px da largura`);
    }
    await p.clicar("#fab");
    const sobra = await p.avaliar(() => { const c = document.querySelector(".folha-caixa"); return c.scrollWidth - c.clientWidth; });
    certo(sobra <= 0, `a folha passa ${sobra}px da largura`);
  },
};

const srv = await servir();
const base = `http://127.0.0.1:${srv.address().port}`;
const cr = await abrirChrome();
let falhas = 0;
// um teste é uma função (movimento desligado) ou { movimento: true, fn } para testar as animações
const SO = process.argv[2]; // opcional: roda só os testes cujo nome contém este texto
for (const [nome, t] of Object.entries(TESTES).filter(([n]) => !SO || n.includes(SO))) {
  const fn = typeof t === "function" ? t : t.fn;
  const p = await novaPagina(cr, base, typeof t !== "function" && !!t.movimento);
  try {
    await fn(p);
    if (p.erros.length) throw new Error(p.erros.join(" | "));
    console.log("ok    " + nome);
  } catch (e) { falhas++; console.log("FALHA " + nome + "\n      " + e.message); }
  await p.fechar().catch(() => {});
}
await cr.fechar(); srv.close();
console.log(falhas ? `\n${falhas} teste(s) falharam` : `\nTodos os ${Object.keys(TESTES).length} testes passaram`);
process.exit(falhas ? 1 : 0);
