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
  const proc = spawn(exe, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${perfil}`, "--no-first-run", "--no-default-browser-check", ...(process.platform === "linux" ? ["--no-sandbox"] : []), "about:blank"], { stdio: "ignore" });
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
async function novaPagina(cr, base, movimento = false, nativo = false, largura = 360, altura = 780) {
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
  if (nativo) await s("Page.addScriptToEvaluateOnNewDocument", { source: `(${capacitorFalso})()` }); // finge o app Android
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
    // liga ou desliga o "reduzir movimento" do aparelho no meio do teste
    reduzir: (sim) => s("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: sim ? "reduce" : "no-preference" }] }),
    // roda um trecho antes do app em cada carregamento seguinte (ex.: ligar um gancho de teste que precisa existir na abertura)
    injetar: (src) => s("Page.addScriptToEvaluateOnNewDocument", { source: src }),
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
// aperta uma tecla como um teclado físico: o evento nasce no elemento com foco e sobe até o document.
// Devolve false se o app chamou preventDefault (o atalho agiu e a tecla não chega ao campo).
const tecla = (p, key, extra = {}) => p.avaliar((key, extra) => (document.activeElement || document.body).dispatchEvent(new KeyboardEvent("keydown", Object.assign({ key, bubbles: true, cancelable: true }, extra))), key, extra);
const calc = async (p, qual) => { await p.aba("calc"); await p.clicar('[data-calc="' + qual + '"]'); };
// Android de mentira: roda dentro da página antes do app (testes com { nativo: true }). Guarda o que o app pediu em window.__nativo.
// A "pasta" e a permissão ficam no localStorage para sobreviver a um recarregar.
function capacitorFalso() {
  const ler = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch (e) { return d; } };
  const N = (window.__nativo = { chamadas: [], voltar: null, minimizou: 0, pediu: 0, responder: "granted", agendadas: [] });
  window.Capacitor = { isNativePlatform: () => true, Plugins: {
    App: { addListener: (ev, fn) => { if (ev === "backButton") N.voltar = fn; return Promise.resolve({ remove() {} }); }, minimizeApp: async () => { N.minimizou++; } },
    Caixinhas: {
      compartilhar: async (a) => { N.chamadas.push(["compartilhar", a]); },
      aparelho: async () => ({ marca: "tst1" }),
      escolherPastaBackup: async () => ({ uri: "content://pasta-de-teste", nome: "Backup" }),
      listarBackups: async () => ({ backups: Object.keys(ler("__pasta", {})).map((n) => ({ doc: n, nome: n, modificado: 0 })) }),
      lerBackup: async ({ doc }) => ({ texto: ler("__pasta", {})[doc] }),
      gravarBackup: async (a) => {
        N.chamadas.push(["gravarBackup", { nome: a.nome, grupo: a.grupo, manter: a.manter }]);
        const o = ler("__pasta", {}); o[a.nome] = a.texto;
        Object.keys(o).filter((n) => n.endsWith(a.grupo)).sort().reverse().slice(a.manter).forEach((n) => delete o[n]);
        localStorage.setItem("__pasta", JSON.stringify(o));
      },
    },
    LocalNotifications: {
      checkPermissions: async () => ({ display: ler("__perm", "prompt") }),
      requestPermissions: async () => { N.pediu++; localStorage.setItem("__perm", JSON.stringify(N.responder)); return { display: N.responder }; },
      getPending: async () => ({ notifications: N.agendadas.map((n) => ({ id: n.id })) }),
      cancel: async ({ notifications }) => { const ids = notifications.map((n) => n.id); N.agendadas = N.agendadas.filter((n) => !ids.includes(n.id)); },
      schedule: async ({ notifications }) => { N.agendadas.push(...notifications.map((n) => ({ id: n.id, title: n.title, body: n.body, at: new Date(n.schedule.at).getTime() }))); return { notifications }; },
    },
  } };
}
// estado com contas em datas relativas a hoje: fatura amanhã, fixo em 3 dias, e casos que não devem aparecer
const semearContas = (p) => p.avaliar(() => {
  const pad = (n) => String(n).padStart(2, "0"), mesDe = (d) => d.getFullYear() + "-" + pad(d.getMonth() + 1);
  const em = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d; };
  const hoje = new Date(), antes = new Date(hoje.getFullYear(), hoje.getMonth() - 2, 1);
  const fixo = (id, desc, valor, forma, d, pulados) => ({ id, desc, valor, caixinha: "a", forma, dia: d.getDate(), desde: mesDe(hoje), pulados: pulados || [] });
  localStorage.setItem("caixinhas-orologia-v1", JSON.stringify({ onboarded: true, guiaVisto: true, caixinhas: [{ id: "a", nome: "Contas", cor: "#9C9BF5" }], limitesPadrao: { a: 1000 },
    cartoes: [{ id: "k1", nome: "Nubank", fecha: em(1).getDate() > 5 ? em(1).getDate() - 5 : 1, vence: em(1).getDate() }, { id: "k2", nome: "Vazio", fecha: 1, vence: em(2).getDate() }],
    compras: [{ id: "c1", cartao: "k1", desc: "Streaming", valorParcela: 44.9, parcelas: 0, inicio: mesDe(antes), dono: "" }],
    fixos: [fixo("f1", "Internet", 100, "Pix", em(3)), fixo("f2", "Netflix", 40, "Crédito", em(3)), fixo("f3", "Academia", 90, "Pix", em(2), [mesDe(em(2))]), fixo("f4", "Seguro", 70, "Pix", em(10))] }));
});
const animando = (p) => p.avaliar(() => document.getAnimations().filter((a) => a.playState === "running").length);
// aporta na meta cujo cartão contém o nome dado
const aportar = (p, nome, valor) => p.avaliar((nome, valor) => { const c = [...document.querySelectorAll("#metasLista .meta-card")].find((x) => x.textContent.includes(nome)); c.querySelector("input").value = valor; c.querySelector('[data-act="meta-aportar"]').click(); }, nome, String(valor));
const cartaoMeta = (p, nome) => p.avaliar((nome) => { const c = [...document.querySelectorAll("#metasLista .meta-card")].find((x) => x.textContent.includes(nome)); return c ? c.textContent.replace(/\s+/g, " ") : ""; }, nome);
const comExemplo = async (p) => { await p.clicar('[data-act="onb-exemplo"]'); await p.espera(200); };
const varCss = (p, nome) => p.avaliar((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim().toUpperCase(), nome);
const lerTemaGuardado = (p) => p.avaliar(() => JSON.parse(localStorage.getItem("caixinhas-orologia-tema") || "{}"));
// cola um tema na Aparência (Colar tema → Importar)
const colarTema = async (p, tema) => {
  await p.aba("ajustes/aparencia");
  await p.clicar('[data-tm="colar"]');
  await p.digitar("#temaCola", typeof tema === "string" ? tema : JSON.stringify(tema));
  await p.clicar('[data-tm="importar"]');
};
// o JSON que o app exporta do tema ativo ("Baixar .json" também mostra o texto)
const temaExportado = async (p) => { await p.aba("ajustes/aparencia"); await p.clicar('[data-tm="baixar"]'); await p.espera(200); return JSON.parse(await p.avaliar(() => document.querySelector("#temaTxt").value)); };
// a mesma conta do app para o brilho derivado (destaque misturado 35% com o fundo)
const misturar = (a, b, t) => "#" + [1, 3, 5].map((i) => { const x = parseInt(a.substr(i, 2), 16), y = parseInt(b.substr(i, 2), 16); return ("0" + Math.round(x + (y - x) * t).toString(16)).slice(-2); }).join("").toUpperCase();
// cores computadas de um elemento, com o fundo e a borda (translúcidos) compostos sobre --bg; contraste pela conta do app
const coresSobreFundo = (p, sel) => p.avaliar((sel) => {
  const lerCor = (s) => {
    let m = /^rgba?\(([^)]+)\)/.exec(s);
    if (m) { const v = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return [v[0], v[1], v[2], v.length > 3 ? v[3] : 1]; }
    m = /^color\(srgb ([^)]+)\)/.exec(s);
    if (m) { const v = m[1].split(/[ /]+/).filter(Boolean).map(Number); return [v[0] * 255, v[1] * 255, v[2] * 255, v.length > 3 ? v[3] : 1]; }
    throw new Error("cor que não sei ler: " + s);
  };
  const hex = (c) => "#" + c.slice(0, 3).map((v) => ("0" + Math.round(Math.max(0, Math.min(255, v))).toString(16)).slice(-2)).join("");
  const sobre = (c, f) => c.slice(0, 3).map((v, i) => v * c[3] + f[i] * (1 - c[3]));
  const bg = lerCor(getComputedStyle(document.body).backgroundColor);
  const e = document.querySelector(sel); if (!e) throw new Error("não achei " + sel);
  const cs = getComputedStyle(e);
  const fundo = sobre(lerCor(cs.backgroundColor), bg), borda = sobre(lerCor(cs.borderTopColor), bg), texto = lerCor(cs.color);
  const C = window.TemaCx.contraste;
  return { bg: hex(bg), fundo: hex(fundo), borda: hex(borda), cBorda: C(hex(borda), hex(bg)), cFundo: C(hex(fundo), hex(bg)), cTexto: C(hex(texto), hex(fundo)) };
}, sel);

const TESTES = {
  "primeira abertura mostra as boas-vindas e o botão Lançar": async (p) => {
    certo(await p.visivel("#inOnb .onb"), "boas-vindas não apareceram");
    certo(await p.visivel("#fab"), "botão Lançar não apareceu");
    certo(!(await p.visivel("#folhaGasto")), "a folha não devia abrir sozinha");
    await p.print("01-primeira-abertura");
  },
  "Início mostra a sobra, o arco e as caixinhas com ícone": async (p) => {
    await comExemplo(p);
    igual(await p.texto("#inSobra"), "R$ 1.230,70", "sobra do mês");
    certo(await p.visivel("#inResumo #arco"), "o arco não apareceu");
    igual(await p.avaliar(() => document.querySelectorAll("#inCx .n-bloco[data-cx] .cxi svg").length), 3, "caixinhas com ícone no Início");
    await p.print("02-inicio", true);
  },
  "Barra do celular tem 4 abas e o + no meio; Ajustes fica na engrenagem": async (p) => {
    await comExemplo(p);
    igual(await p.avaliar(() => [...document.querySelectorAll(".tabs a[data-tab]")].map((a) => a.dataset.tab).join(",")), "inicio,mes,cartao,metas", "abas na barra");
    igual(await p.avaliar(() => !!document.querySelector(".tabs #fab")), true, "o + devia ficar dentro da barra");
    igual(await p.avaliar(() => [...document.querySelector(".tabs nav").children].map((e) => (e.id === "fab" ? "+" : e.dataset.tab)).join(",")), "inicio,mes,+,cartao,metas", "ordem da barra");
    certo(await p.visivel("header.top #btnAjustes"), "a engrenagem não está no topo");
    await p.clicar("#btnAjustes");
    igual(await p.abaAtual(), "ajustes", "a engrenagem leva aos Ajustes");
    igual(await p.avaliar(() => document.querySelector("#btnAjustes").getAttribute("aria-current")), "page", "engrenagem marcada nos Ajustes");
    igual(await p.avaliar(() => document.querySelectorAll('.tabs a[aria-current="page"]').length), 0, "nenhuma aba da barra marcada nos Ajustes");
    await p.clicar("#fab");
    certo(await p.visivel("#folhaGasto"), "o + devia abrir a folha de lançar");
  },
  "Arco do Início tem um pedaço por caixinha com gasto e o marcador de hoje": async (p) => {
    await comExemplo(p);
    const comGasto = await p.avaliar(() => {
      const d = new Date(), k = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
      return [...new Set(JSON.parse(localStorage.getItem("caixinhas-orologia-v1")).meses[k].gastos.filter((g) => g.valor > 0).map((g) => g.caixinha))].sort().join(",");
    });
    igual(comGasto, "diaadia,lazer", "caixinhas com gasto no exemplo");
    igual(await p.avaliar(() => [...document.querySelectorAll("#arco .arco-seg")].map((s) => s.dataset.cx).sort().join(",")), comGasto, "um pedaço do arco por caixinha com gasto");
    // o tamanho de cada pedaço segue o gasto sobre o limite total (Lazer 179,90 e Dia a dia 89,40 de 1.500)
    const comp = await p.avaliar(() => Object.fromEntries([...document.querySelectorAll("#arco .arco-seg")].map((s) => [s.dataset.cx, s.getTotalLength()])));
    const trilha = await p.avaliar(() => document.querySelector("#arco .arco-trilha").getTotalLength());
    certo(Math.abs((comp.lazer + comp.diaadia) / trilha - 269.3 / 1500) < 0.02, "o arco aceso devia ser 18% da trilha: " + JSON.stringify(comp) + " de " + trilha);
    certo(comp.lazer > comp.diaadia * 1.7, "o pedaço do Lazer devia ser o dobro do Dia a dia: " + JSON.stringify(comp));
    certo(await p.visivel("#arcoHoje"), "o marcador de hoje não apareceu");
    const ang = await p.avaliar(() => parseFloat(/rotate\(([-\d.]+)/.exec(document.querySelector("#arcoHoje").getAttribute("transform") || "")?.[1]));
    const esperado = await p.avaliar(() => { const d = new Date(); return (d.getDate() / new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()) * 180; });
    certo(Math.abs(ang - esperado) < 0.5, "o marcador de hoje devia estar em " + esperado + "° e está em " + ang + "°");
    igual(await p.texto("#inSobra"), "R$ 1.230,70", "sobra no centro do arco");
    certo(/^R\$ [\d.]+,\d\d$/.test(await p.texto("#inDia")), "valor por dia: " + await p.texto("#inDia"));
    igual(await p.avaliar(() => document.querySelectorAll("#inCx .n-bloco[data-cx]").length), 3, "blocos das caixinhas");
  },
  "Ritmo do mês: abaixo e acima": async (p) => {
    await p.avaliar(() => localStorage.setItem("caixinhas-orologia-v1", JSON.stringify({ onboarded: true, guiaVisto: true, caixinhas: [{ id: "a", nome: "Tudo", cor: "#9C9BF5" }], limitesPadrao: { a: 1500 } })));
    await p.recarregar();
    const ideal = await p.avaliar(() => { const d = new Date(); return Math.round((1500 * d.getDate()) / new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()); });
    igual(await p.texto("#chipRitmo"), "R$ " + ideal.toLocaleString("pt-BR") + " abaixo do ritmo", "nada gasto: abaixo do ritmo pelo ideal de hoje");
    certo(await p.visivel("#ritmoIni"), "o gráfico do ritmo não apareceu");
    await lancar(p, 2000, "Notebook");
    igual(await p.texto("#chipRitmo"), "R$ " + (2000 - ideal).toLocaleString("pt-BR") + " acima do ritmo", "gasto maior que o ritmo do dia: acima");
    const ruim = await p.avaliar(() => [...document.querySelectorAll("#ritmoIni, #ritmoIni *")].flatMap((e) => [...e.attributes].map((a) => a.value)).filter((v) => /NaN|undefined|Infinity/.test(v)));
    igual(ruim.join(" | "), "", "atributos quebrados no gráfico do ritmo");
    await p.clicar("#inRitmo");
    igual(await p.abaAtual(), "graficos", "tocar no Ritmo do mês leva aos Gráficos");
  },
  "Início aguenta valores e nomes grandes": async (p) => {
    const semear = (sinal) => p.avaliar((sinal) => {
      const d = new Date(), k = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
      const cores = ["#9C9BF5", "#E3C98A", "#C9A6F5", "#8FD3B4", "#F2A48A", "#8FB8F5"];
      const caixinhas = Array.from({ length: 12 }, (_, i) => ({ id: "c" + i, nome: i === 2 ? "Supermercado, padaria e feiras" : "Caixinha " + (i + 1), cor: cores[i % cores.length] }));
      const limitesPadrao = Object.fromEntries(caixinhas.map((c) => [c.id, 0]));
      const gastos = [{ id: "g1", valor: 100, descricao: "Sem limite", caixinha: "c1", forma: "Pix", data: k + "-01" }];
      if (sinal > 0) limitesPadrao.c0 = 1234667.89; // sobra total de 1.234.567,89, com a c1 negativa
      else gastos.push({ id: "g2", valor: 1234467.89, descricao: "Casa", caixinha: "c0", forma: "Pix", data: k + "-01" }); // sobra total de -1.234.567,89
      localStorage.setItem("caixinhas-orologia-v1", JSON.stringify({ onboarded: true, guiaVisto: true, caixinhas, limitesPadrao, meses: { [k]: { gastos } } }));
    }, sinal);
    await p.tamanho(320, 640);
    for (const [sinal, txt] of [[1, "R$ 1.234.567,89"], [-1, "-R$ 1.234.567,89"]]) {
      await semear(sinal); await p.recarregar();
      igual(await p.texto("#inSobra"), txt, "sobra grande");
      igual(await p.avaliar(() => "Supermercado, padaria e feiras".length), 30, "nome de 30 letras");
      const m = await p.avaliar(() => {
        const a = document.querySelector("#arco").getBoundingClientRect(), s = document.querySelector("#inSobra").getBoundingClientRect();
        const blocos = [...document.querySelectorAll("#inCx .n-bloco[data-cx]")].filter((b) => b.scrollWidth > b.clientWidth + 1).map((b) => b.dataset.cx);
        return { sobra: document.documentElement.scrollWidth - innerWidth, dentro: s.left >= a.left - 0.5 && s.right <= a.right + 0.5 && s.width > 0, larg: [a.left, a.right, s.left, s.right].map(Math.round).join(","), blocos: blocos.join(","), n: document.querySelectorAll("#inCx .n-bloco[data-cx]").length };
      });
      certo(m.sobra <= 0, "o Início passa " + m.sobra + "px da largura");
      certo(m.dentro, "a sobra passa da caixa do arco (arco e sobra: " + m.larg + ")");
      igual(m.blocos, "", "blocos com conteúdo estourando");
      igual(m.n, 12, "doze blocos");
      certo((await p.texto('#inCx .n-bloco[data-cx="c1"]')).includes("passou R$ 100,00"), "a caixinha sem limite com gasto avisa quanto passou");
    }
    await p.print("16-inicio-valores-grandes", true);
  },
  "Início vazio não mostra NaN": async (p) => {
    const casos = [
      ["primeira abertura", null, 0],
      ["backup sem caixinhas (o normalize devolve as de fábrica e o app abre)", { onboarded: true, guiaVisto: true, caixinhas: [], limitesPadrao: {} }, 0],
      ["caixinha sem limite", { onboarded: true, guiaVisto: true, caixinhas: [{ id: "a", nome: "Avulsos", cor: "#9C9BF5" }], limitesPadrao: { a: 0 } }, 0],
      ["caixinha sem limite com gasto", { onboarded: true, guiaVisto: true, caixinhas: [{ id: "a", nome: "Avulsos", cor: "#9C9BF5" }], limitesPadrao: { a: 0 }, gasto: 30 }, 1],
    ];
    for (const [nome, estado, pedacos] of casos) {
      if (estado) {
        await p.avaliar((estado) => {
          const d = new Date(), k = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
          if (estado.gasto) estado.meses = { [k]: { gastos: [{ id: "g1", valor: estado.gasto, descricao: "Pão", caixinha: "a", forma: "Pix", data: k + "-01" }] } };
          localStorage.setItem("caixinhas-orologia-v1", JSON.stringify(estado));
        }, estado);
        await p.recarregar();
      }
      const r = await p.avaliar(() => {
        const v = document.querySelector("#v-inicio");
        const attrs = [...v.querySelectorAll("*")].flatMap((e) => [...e.attributes].map((a) => a.value)).filter((x) => /NaN|Infinity|undefined/.test(x));
        return { txt: (v.textContent.match(/.{0,30}(NaN|Infinity|undefined).{0,30}/) || [""])[0], attrs: attrs.join(" | "), segs: document.querySelectorAll("#arco .arco-seg").length };
      });
      igual(r.txt, "", "texto quebrado no Início (" + nome + ")");
      igual(r.attrs, "", "atributos quebrados no Início (" + nome + ")");
      igual(r.segs, pedacos, "pedaços do arco (" + nome + ")");
      certo(await p.visivel("#arco .arco-trilha"), "a trilha do arco devia aparecer (" + nome + ")");
    }
  },
  "Quem vem da 1.9 abre a 2.0 com tudo no lugar": async (p) => {
    await semearContas(p);
    await p.avaliar(() => localStorage.setItem("caixinhas-orologia-tema", JSON.stringify({ atual: "g-mare", meus: [{ id: "tmeu1", nome: "Meu roxo", fundo: "#1A1030", card: "#2A1F45", texto: "#F5F0FF", suave: "#B8A8D8", destaque: "#C78BFF", secundaria: "#FFD27A", raio: 16, fonte: "padrao" }] })));
    await p.recarregar();
    igual(await p.avaliar(() => getComputedStyle(document.documentElement).getPropertyValue("--bg").trim()), "#0A1418", "o tema escolhido (Maré) continua aplicado");
    const esperado = await p.avaliar(() => {
      const d = new Date(), k = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
      const gs = JSON.parse(localStorage.getItem("caixinhas-orologia-v1")).meses[k].gastos;
      return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(1000 - gs.reduce((a, g) => a + g.valor, 0)).replace(/\s/g, " ");
    });
    igual(await p.texto("#inSobra"), esperado, "sobra com os gastos fixos lançados");
    certo((await p.texto("#inVencer")).includes("Internet"), "o A vencer continua no Início");
    await p.aba("mes");
    certo((await p.texto("#mesLista")).includes("Internet"), "os lançamentos continuam no Mês");
    await p.aba("ajustes/aparencia");
    certo((await p.texto("#temaBox")).includes("Meu roxo"), "o tema próprio continua na Aparência");
    // a chave da 1.9 não tem "leve": visual completo, chave desligada, e nada é reescrito só por abrir
    igual(await p.avaliar(() => document.documentElement.hasAttribute("data-leve") + "|" + document.querySelector("#tgLeve").checked + "|" + document.querySelector("#tgLeveNota").hidden), "false|false|true", "visual leve desligado para quem vem da 1.9");
    igual(await p.avaliar(() => "leve" in JSON.parse(localStorage.getItem("caixinhas-orologia-tema"))), false, "a chave do tema continua sem leve");
  },
  "Início e telas vizinhas sem estourar, nos temas noite e dia (prints)": async (p) => {
    await comExemplo(p);
    for (const tema of ["noite", "dia"]) {
      await p.avaliar((tema) => localStorage.setItem("caixinhas-orologia-tema", JSON.stringify({ atual: tema, meus: [] })), tema);
      for (const [w, h] of [[360, 780], [320, 640], [1280, 800]]) {
        await p.tamanho(w, h); await p.recarregar();
        for (const t of ["inicio", "mes", "graficos", "cartao", "metas", "calc", "ajustes", "ajustes/aparencia", "ajustes/caixinhas", "ajustes/pin", "ajustes/dados", "guia", "apoie"]) {
          await p.aba(t);
          const sobra = await p.avaliar(() => document.documentElement.scrollWidth - innerWidth);
          certo(sobra <= 0, `a aba ${t} passa ${sobra}px da largura em ${w}px no tema ${tema}`);
          const nome = t.replace("/", "-");
          await p.print(`20-${nome}-${tema}-${w}`);
          if (["inicio", "mes", "cartao", "metas"].includes(t)) await p.print(`20-${nome}-${tema}-${w}-inteira`, true);
        }
        await p.aba("inicio"); await p.clicar("#fab"); await p.espera(150);
        await p.print(`20-folha-${tema}-${w}`);
        await p.clicar('.folha-topo [data-act="folha-fechar"]');
        // edição de um gasto (com Apagar), aviso, passo a passo da primeira abertura e trava do PIN
        await p.aba("mes"); await p.clicar("#mesLista .n-lanc"); await p.espera(150);
        await p.print(`20-folha-editar-${tema}-${w}`);
        await p.clicar('.folha-topo [data-act="folha-fechar"]');
        await p.avaliar(() => { const t = document.querySelector("#toast"); t.textContent = "Lançado. Lazer: sobra R$ 470,10"; t.hidden = false; });
        await p.print(`20-aviso-${tema}-${w}`);
        await p.clicar('#v-guia [data-act="onb-replay"]');
        await p.print(`20-passo-a-passo-${tema}-${w}`);
        await p.clicar('[data-act="onb-next"]'); await p.print(`20-passo-a-passo-2-${tema}-${w}`);
        await p.clicar('[data-act="onb-prev"]'); await p.clicar('[data-act="onb-skip"]');
        await p.avaliar(() => document.documentElement.setAttribute("data-trava", ""));
        await p.print(`20-pin-${tema}-${w}`);
        await p.avaliar(() => document.documentElement.removeAttribute("data-trava"));
      }
    }
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
    igual(await p.texto("#inSobra"), "R$ 1.180,70", "sobra depois do gasto");
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
    await p.clicar("#mesLista .n-lanc[data-id]"); // a linha inteira é o botão de editar
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
  "Barra com 4 abas e o +, e Calculadoras pelo Início": async (p) => {
    await comExemplo(p);
    igual(await p.avaliar(() => document.querySelectorAll(".tabs nav > *").length), 5, "4 abas e o + na barra");
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
  "Abertura longa toca toda vez que o app abre; ao voltar para o Início, a curta": { movimento: true, fn: async (p) => {
    await comExemplo(p);
    await p.espera(2200);
    igual(await p.avaliar(() => document.querySelector("#inResumo").dataset.abertura), "longa", "primeira abertura do dia");
    igual(await p.texto("#inSobra"), "R$ 1.230,70", "sobra ao fim da abertura longa");
    await p.recarregar(); await p.espera(300);
    igual(await p.avaliar(() => document.querySelector("#inResumo").dataset.abertura), "longa", "abrir o app de novo no mesmo dia");
    await p.espera(2200); await p.aba("mes"); await p.aba("inicio"); await p.espera(700);
    igual(await p.avaliar(() => document.querySelector("#inResumo").dataset.abertura), "curta", "voltar para o Início sem fechar o app");
    igual(await p.texto("#inSobra"), "R$ 1.230,70", "sobra ao fim da abertura curta");
  } },
  "Durante a abertura a sobra conta até o valor": { movimento: true, fn: async (p) => {
    await comExemplo(p);
    await p.avaliar(() => { localStorage.removeItem("caixinhas-orologia-abertura"); location.reload(); }).catch(() => {});
    let contou = false;
    for (let i = 0; i < 24 && !contou; i++) { await p.espera(50); const v = await p.texto("#inSobra").catch(() => null); if (v && v !== "R$ 1.230,70") contou = true; }
    certo(contou, "a sobra apareceu pronta, sem contar");
    await p.espera(2200);
    igual(await p.texto("#inSobra"), "R$ 1.230,70", "sobra ao fim da contagem");
    igual(await p.avaliar(() => document.querySelectorAll("#inCx .n-bloco[data-cx]").length), 3, "caixinhas no Início");
  } },
  "Início se refaz quando as caixinhas mudam": async (p) => {
    await comExemplo(p);
    await p.aba("ajustes");
    await p.clicar('[data-act="cx-add"]'); await p.clicar('[data-act="cx-save"]');
    await p.aba("inicio");
    igual(await p.avaliar(() => document.querySelectorAll("#inCx .n-bloco[data-cx]").length), 4, "caixinhas no Início depois de criar uma");
    igual(await p.texto("#inSobra"), "R$ 1.230,70", "sobra não muda com caixinha sem limite");
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
    igual(await p.texto("#inSobra"), "R$ 1.230,70", "sobra depois de desbloquear");
  } },
  "Início no tema claro": async (p) => {
    await comExemplo(p);
    await p.aba("ajustes");
    await p.avaliar(() => document.querySelectorAll('[data-tm="usar"]')[1].click());
    await p.aba("inicio"); await p.espera(3600);
    igual(await p.texto("#inSobra"), "R$ 1.230,70", "sobra no tema claro");
    await p.print("07-inicio-claro");
  },
  "Arco aguenta caixinha sem limite": async (p) => {
    const semear = (comGasto) => p.avaliar((comGasto) => {
      const d = new Date(), mes = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
      localStorage.setItem("caixinhas-orologia-v1", JSON.stringify({ onboarded: true, caixinhas: [{ id: "a", nome: "Avulsos", cor: "#9C9BF5" }, { id: "b", nome: "Outra", cor: "#E3C98A" }], limitesPadrao: { a: 0, b: 0 },
        meses: comGasto ? { [mes]: { gastos: [{ id: "g1", valor: 30, descricao: "Pão", caixinha: "a", forma: "Pix", data: mes + "-01" }] } } : {} }));
    }, comGasto);
    for (const comGasto of [true, false]) {
      await semear(comGasto); await p.recarregar();
      const ruim = await p.avaliar(() => [...document.querySelectorAll("#inResumo #arco, #inResumo #arco *")].flatMap((e) => [...e.attributes].map((a) => a.value)).filter((v) => /NaN|undefined|Infinity/.test(v)));
      igual(ruim.length, 0, "atributos quebrados no arco (" + (comGasto ? "com" : "sem") + " gasto): " + ruim.join(" | "));
      igual(await p.texto("#inSobra"), comGasto ? "-R$ 30,00" : "R$ 0,00", "sobra sem limite");
      // a ponta esquerda do arco segue o primeiro pedaço: sem limite, o gasto todo já passou dele (cor de alerta)
      const ini = await p.avaliar(() => { const c = document.querySelector('#arco [data-d="ini"]'); return c.getAttribute("opacity") === "1" ? c.getAttribute("fill") : "escondida"; });
      igual(ini, comGasto ? "var(--over)" : "escondida", "cor da ponta esquerda do arco (" + (comGasto ? "com" : "sem") + " gasto)");
      // sobra negativa: não diz "R$ 0,00 por dia"
      const dia = await p.avaliar(() => document.querySelector("#inResumo .dia").innerText.replace(/\s+/g, " ").trim()); // o que aparece (e o leitor de tela ouve)
      if (comGasto) certo(dia === "passou do limite" && !/por dia/.test(dia), "com a sobra negativa o centro do arco devia dizer só que passou do limite: " + dia);
      else certo(/por dia/.test(dia), "sem gasto o centro do arco diz o valor por dia: " + dia);
    }
  },
  "Estourou: mostra quanto passou": async (p) => {
    await comExemplo(p);
    await lancar(p, 600, "Viagem de fim de semana");
    certo((await p.texto('#inCx .n-bloco[data-cx="lazer"]')).includes("passou R$ 79,90"), "a caixinha estourada devia dizer quanto passou: " + await p.texto('#inCx .n-bloco[data-cx="lazer"]'));
    igual(await p.texto('#inCx .n-bloco[data-cx="diaadia"] small'), "", "caixinha dentro do limite não tem aviso");
    certo(await p.avaliar(() => { const e = document.querySelector('#arco .arco-exc[data-cx="lazer"]'); return !!e && e.getTotalLength() > 1; }), "o trecho que passou do limite devia aparecer no arco");
  },
  "Lançar no Início faz o arco reagir": { movimento: true, fn: async (p) => {
    await comExemplo(p); await p.espera(2300);
    await lancar(p, 50, "Cinema");
    certo((await animando(p)) > 0, "nada se moveu depois de lançar");
    igual(await p.texto("#inResumo .ficha"), "− R$ 50,00", "valor lançado no centro do arco");
    await p.espera(1500);
    igual(await animando(p), 0, "animações que não terminaram");
    igual(await p.texto("#inSobra"), "R$ 1.180,70", "sobra depois de lançar");
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
    igual(await p.texto("#inSobra"), "R$ 1.180,70", "sobra depois de lançar durante a abertura");
    igual(await p.texto('#inCx .n-bloco[data-cx="lazer"] .v'), "R$ 470,10", "sobra do Lazer");
  } },
  "Abertura curta: só o arco e os anéis andam, os números já vêm certos": { movimento: true, fn: async (p) => {
    await comExemplo(p); await p.espera(2300); // a longa já tocou
    await p.aba("mes"); await p.avaliar(() => { location.hash = "#inicio"; }); // voltar para o Início toca a curta
    const vistos = [];
    for (let i = 0; i < 12; i++) { await p.espera(30); const v = await p.avaliar(() => { const b = document.querySelector("#inSobra"), l = document.querySelector('#inCx .n-bloco[data-cx="lazer"] .v'); return b && l && b.textContent ? (b.textContent + " | " + l.textContent).replace(/\s/g, " ") : null; }).catch(() => null); if (v) vistos.push(v); }
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
    for (let i = 0; i < 40; i++) { await p.espera(40); const c = await p.avaliar(() => { const b = document.querySelector("#inSobra"); return b && b.textContent ? String(b.classList.contains("longo")) : null; }).catch(() => null); if (c) classes.add(c); }
    igual(classes.size, 1, "o tamanho do número mudou durante a contagem: " + [...classes].join(","));
    igual(await p.texto("#inSobra"), "R$ 5,00", "sobra no fim");
  } },
  "Aviso 'passou R$' aparece inteiro mesmo com nome comprido": async (p) => {
    await p.avaliar(() => {
      const d = new Date(), mes = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
      localStorage.setItem("caixinhas-orologia-v1", JSON.stringify({ onboarded: true, caixinhas: [{ id: "a", nome: "Mercado e padaria do bairro", cor: "#9C9BF5" }], limitesPadrao: { a: 100 },
        meses: { [mes]: { gastos: [{ id: "g1", valor: 250, descricao: "Compras", caixinha: "a", forma: "Pix", data: mes + "-01" }] } } }));
    });
    await p.tamanho(320, 640); await p.recarregar(); await p.espera(1500);
    const m = await p.avaliar(() => { const b = document.querySelector("#inCx .n-bloco[data-cx]"), s = b.querySelector("small"), r = s.getBoundingClientRect(), rb = b.getBoundingClientRect(); return { texto: s.textContent, dentro: r.right <= rb.right + 1 && r.left >= rb.left - 1 && r.bottom <= rb.bottom + 1 && r.width > 0, nomeCortado: b.scrollWidth > b.clientWidth + 1 || b.scrollHeight > b.clientHeight + 1 }; });
    igual(m.texto.replace(/\s/g, " "), "passou R$ 150,00", "texto do aviso");
    certo(m.dentro, "o aviso 'passou' ficou fora da área visível do bloco");
    igual(m.nomeCortado, false, "o bloco inteiro estourou a largura");
  },
  "Gastar além do limite durante a abertura não corta o marcador de hoje": { movimento: true, fn: async (p) => {
    await comExemplo(p);
    await p.avaliar(() => { localStorage.removeItem("caixinhas-orologia-abertura"); location.reload(); }).catch(() => {});
    await p.espera(120);
    await p.avaliar(() => {
      // ângulo do marcador de hoje no arco (anda de 0 até a posição do dia durante a abertura longa)
      window.__fio = () => parseFloat((/rotate\(([-\d.]+)/.exec(document.querySelector("#arcoHoje").getAttribute("transform") || "") || [0, 0])[1]);
      const arcoVisto = () => { const a = document.querySelector("#arco"), an = a.getAnimations()[0]; return { el: a, op: Number(getComputedStyle(a).opacity), prog: an ? an.effect.getComputedTiming().progress : null }; };
      document.addEventListener("click", (e) => { if (e.target.closest && e.target.closest("#gBtn")) {
        const a0 = arcoVisto(); window.__antes = window.__fio(); window.__opAntes = a0.op; window.__prog0 = a0.prog;
        setTimeout(() => { const a1 = arcoVisto(); window.__depois = window.__fio(); window.__refez = a1.el !== a0.el; window.__opDepois = a1.op; window.__prog = a1.prog; }, 40);
      } }, true);
    });
    // Objetivos ainda não tem gasto no exemplo: o primeiro gasto nela cria um pedaço novo e obriga a refazer o arco no meio da abertura
    // tudo de uma vez, para o lançamento chegar enquanto a entrada do arco (700 ms) ainda corre, mas já longe do começo
    // (no começo o marcador anda rápido demais para medir o salto em 40 ms)
    await p.espera(300);
    await p.avaliar(() => {
      document.querySelector("#fab").click(); document.querySelector('label[for="' + document.querySelector('input[name="gCx"][value="objetivos"]').id + '"]').click();
      for (const [q, v] of [["#gValor", "400"], ["#gDesc", "Viagem"]]) { const e = document.querySelector(q); e.value = v; e.dispatchEvent(new Event("input", { bubbles: true })); }
      document.querySelector("#gBtn").click();
    });
    await p.espera(2500);
    const f = await p.avaliar(() => ({ antes: window.__antes, depois: window.__depois, fim: window.__fio(), refez: window.__refez, opAntes: window.__opAntes, opDepois: window.__opDepois, prog0: window.__prog0, prog: window.__prog, segs: document.querySelectorAll("#arco .arco-seg").length }));
    certo(f.refez, "o lançamento devia refazer o arco no meio da abertura");
    igual(f.segs, 3, "pedaços do arco depois do primeiro gasto em Objetivos");
    certo(f.antes < f.fim * 0.9, "o teste chegou tarde: o marcador já estava em " + f.antes + " de " + f.fim);
    certo(f.depois - f.antes < f.fim * 0.15, "o marcador saltou de " + f.antes + " para " + f.depois + " (fim " + f.fim + ")");
    certo(f.opDepois >= f.opAntes - 0.15, "o arco refeito apagou: opacidade " + f.opAntes + " → " + f.opDepois);
    // a entrada do arco continua de onde estava: o lançamento chega com ela ainda correndo, e o arco refeito segue do mesmo
    // ponto (não recomeça, não some e não pula para o fim)
    certo(f.prog0 !== null, "o teste chegou tarde: a entrada do arco já tinha terminado no clique");
    certo(f.prog !== null && f.prog >= f.prog0 - 0.05, "o arco refeito não seguiu a entrada: progresso " + f.prog0 + " → " + f.prog);
  } },
  "Lançamentos seguidos não se atropelam": { movimento: true, fn: async (p) => {
    await comExemplo(p);
    await lancar(p, 10, "Um"); await lancar(p, 20, "Dois"); await lancar(p, 30, "Três");
    await p.espera(1600);
    igual(await p.texto("#inSobra"), "R$ 1.170,70", "sobra depois de três lançamentos");
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
  "Gráfico dos 6 meses anima ao abrir os Gráficos, e o Mês leva até eles": { movimento: true, fn: async (p) => {
    await comExemplo(p); await p.aba("mes");
    igual(await p.avaliar(() => !!document.querySelector("#dGraf, #grafBox")), false, "a sanfona antiga dos gráficos devia sair do Mês");
    await p.clicar("#mesGraf"); await p.espera(60);
    igual(await p.abaAtual(), "graficos", "o cartão do Mês leva aos Gráficos");
    certo((await p.avaliar(() => [...document.querySelectorAll("#gSeis .gb")].reduce((a, g) => a + g.getAnimations().length, 0))) > 0, "as barras dos 6 meses não se moveram");
  } },
  "Gráficos têm tela própria com cinco leituras": async (p) => {
    await comExemplo(p); await p.aba("graficos");
    // um id repetido faz $(id) achar o elemento errado (o gráfico das formas já tomou o lugar do campo Forma da folha)
    igual(await p.avaliar(() => { const v = {}; document.querySelectorAll("[id]").forEach((e) => { v[e.id] = (v[e.id] || 0) + 1; }); return Object.keys(v).filter((k) => v[k] > 1).join(","); }), "", "ids repetidos na página");
    for (const id of ["gRitmo", "gRosca", "gSeis", "gDias", "gFormas"]) {
      const r = await p.avaliar((id) => { const s = document.querySelector("#" + id + " svg[role='img']"); if (!s) return null; const b = s.getBoundingClientRect(); return { rot: s.getAttribute("aria-label") || "", w: b.width, h: b.height, foco: document.querySelectorAll("#" + id + " [tabindex='0']").length }; }, id);
      certo(r, "#" + id + " não tem o gráfico (svg com role=img)");
      certo(r.w > 100 && r.h > 40, "#" + id + " não aparece: " + JSON.stringify(r));
      certo(r.rot.length > 12, "#" + id + " sem resumo em texto para leitor de tela: " + r.rot);
      igual(r.foco, 1, "#" + id + ": um ponto alcançável pelo Tab (os outros pelas setas)");
    }
    // por forma de pagamento: do maior para o menor (Crédito 120, Pix 110,40, Débito 38,90)
    igual(await p.avaliar(() => [...document.querySelectorAll("#gFormas .g-pt")].map((x) => x.getAttribute("aria-label").split(",")[0]).join(",")), "Crédito,Pix,Débito", "formas de pagamento");
    // as setas de mês trocam o mesmo mês do Mês
    const mesAtual = await p.texto("#gMesLabel");
    await p.clicar('#v-graficos [data-act="mes-prev"]');
    const anterior = await p.texto("#gMesLabel");
    certo(anterior && anterior !== mesAtual, "a seta não trocou o mês dos Gráficos: " + anterior);
    await p.aba("mes");
    igual(await p.texto("#mesLabel"), anterior, "o Mês acompanha o mês escolhido nos Gráficos");
    await p.aba("graficos"); await p.clicar('#v-graficos [data-act="mes-hoje"]');
    igual(await p.texto("#gMesLabel"), mesAtual, "o botão do meio volta ao mês atual");
    // no PC, os gráficos ficam em duas colunas
    await p.tamanho(1280, 800); await p.recarregar(); await p.aba("graficos");
    const c = await p.avaliar(() => { const r = (id) => { const b = document.getElementById(id).closest("section").getBoundingClientRect(); return { top: Math.round(b.top), left: Math.round(b.left) }; }; return { a: r("gRosca"), b: r("gSeis") }; });
    certo(Math.abs(c.a.top - c.b.top) < 4 && c.b.left - c.a.left > 200, "no PC a rosca e os 6 meses deviam ficar lado a lado: " + JSON.stringify(c));
  },
  "Rosca soma 100% e segue as caixinhas": async (p) => {
    await comExemplo(p); await p.aba("graficos");
    const ler = () => p.avaliar(() => ({
      fatias: [...document.querySelectorAll("#gRosca .gr-fatia")].map((f) => f.getAttribute("stroke")),
      leg: [...document.querySelectorAll("#gRosca .n-legenda li")].map((li) => [...li.children].map((c) => c.textContent.trim()).join(" ").replace(/\s+/g, " ").trim()),
    }));
    let r = await ler();
    igual(r.fatias.join(","), "#E3C98A,#9C9BF5", "uma fatia por caixinha com gasto, na cor dela (Lazer e Dia a dia)");
    certo(r.leg[0].includes("Lazer") && r.leg[0].includes("R$ 179,90") && r.leg[1].includes("Dia a dia") && r.leg[1].includes("R$ 89,40"), "legenda: " + r.leg.join(" | "));
    const soma = (leg) => leg.reduce((a, t) => a + Number((/(\d+)%/.exec(t) || [0, NaN])[1]), 0);
    certo(soma(r.leg) >= 99 && soma(r.leg) <= 101, "as porcentagens da legenda deviam somar 100: " + r.leg.join(" | "));
    // uma caixinha nova com gasto ganha a sua fatia
    await p.clicar("#fab"); await p.clicar('input[name="gCx"][value="objetivos"]');
    await p.digitar("#gValor", "33,33"); await p.digitar("#gDesc", "Presente"); await p.clicar("#gBtn");
    igual(await p.abaAtual(), "graficos", "lançar pelos Gráficos não sai da tela");
    r = await ler();
    igual(r.fatias.length, 3, "três caixinhas com gasto, três fatias");
    certo(soma(r.leg) >= 99 && soma(r.leg) <= 101, "depois de lançar, a soma devia seguir 100: " + r.leg.join(" | "));
  },
  "Calendário: tocar no dia mostra o total e leva à lista do dia": async (p) => {
    await comExemplo(p); await p.aba("graficos");
    const dia = (n) => '#gDias .g-pt[data-dia="' + n + '"]';
    // cada dia fica mais forte quanto maior o gasto: o dia 4 (R$ 120) mais forte que o dia 3 (R$ 18,50) e que um dia sem gasto
    const forca = (n) => p.avaliar((n) => { const c = document.querySelector('#gDias .g-cel[data-dia="' + n + '"]'); return c ? Number((/(\d+(?:\.\d+)?)%/.exec(c.getAttribute("style") || "") || [0, 0])[1]) : -1; }, n);
    const tocar = (q) => p.avaliar((q) => document.querySelector(q).dispatchEvent(new MouseEvent("click", { bubbles: true })), q).then(() => p.espera(150));
    const [f4, f3, f1] = [await forca(4), await forca(3), await forca(1)];
    certo(f4 > f3 && f3 > 0, "intensidade dos dias 4 e 3: " + f4 + " e " + f3);
    certo(f1 >= 0 && f1 < f3, "um dia sem gasto devia ser o mais fraco: " + f1);
    await p.avaliar((q) => document.querySelector(q).dispatchEvent(new PointerEvent("pointerenter")), dia(4));
    certo(await p.visivel("#grafDica"), "a etiqueta não apareceu ao tocar no dia");
    certo((await p.texto("#grafDica")).includes("R$ 120,00"), "total do dia na etiqueta: " + await p.texto("#grafDica"));
    await tocar(dia(4));
    igual(await p.abaAtual(), "mes", "tocar no dia leva ao Mês");
    const lista = await p.texto("#mesLista");
    certo(lista.includes("Show com amigos") && !lista.includes("Uber") && !lista.includes("Livro"), "a lista devia ter só os gastos do dia 4: " + lista);
    certo((await p.texto("#fResumo")).includes("R$ 120,00"), "o total do dia na lista: " + await p.texto("#fResumo"));
    certo(await p.visivel("#fDia"), "a lista devia dizer que está filtrada pelo dia");
    await p.clicar('[data-act="filtro-limpar"]');
    const tudo = await p.texto("#mesLista");
    certo(tudo.includes("Uber") && tudo.includes("Livro"), "limpar os filtros devia trazer o mês inteiro de volta: " + tudo);
    igual(await p.visivel("#fDia"), false, "o filtro do dia some ao limpar");
    // trocar de mês também tira o filtro do dia
    await p.aba("graficos"); await tocar(dia(4));
    certo(await p.visivel("#fDia"), "tocar no dia de novo filtra de novo");
    await p.clicar('#v-mes [data-act="mes-prev"]');
    igual(await p.visivel("#fDia"), false, "o filtro do dia não passa para outro mês");
    // mesmo com "Buscar em todos os meses" marcado, trocar de mês tira o filtro do dia
    await p.clicar('#v-mes [data-act="mes-hoje"]');
    await p.aba("graficos"); await tocar(dia(4));
    await p.avaliar(() => { const c = document.querySelector("#fTodos"); c.checked = true; c.dispatchEvent(new Event("change", { bubbles: true })); });
    certo(await p.visivel("#fDia"), "o filtro do dia continua com todos os meses marcado");
    await p.clicar('#v-mes [data-act="mes-prev"]');
    igual(await p.visivel("#fDia"), false, "trocar de mês tira o filtro do dia, também com todos os meses");
    // tirar o filtro do dia pelo × não deixa o foco solto na página
    await p.clicar('#v-mes [data-act="mes-hoje"]');
    await p.aba("graficos"); await tocar(dia(4));
    await p.clicar('[data-act="filtro-dia-tirar"]');
    igual(await p.visivel("#fDia"), false, "o × tira o filtro do dia");
    igual(await p.avaliar(() => document.activeElement && document.activeElement.id), "mesLista", "o foco vai para a lista depois de tirar o filtro do dia");
  },
  "Tocar num ponto mostra o valor": async (p) => {
    await comExemplo(p); await p.aba("graficos");
    const fechar = () => p.avaliar(() => document.querySelector("#v-graficos h2").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })));
    for (const q of ['#gRitmo .g-pt[tabindex="0"]', "#gRosca .g-pt", "#gSeis .g-pt:last-child", '#gDias .g-pt[data-dia="4"]', "#gFormas .g-pt"]) {
      await fechar();
      igual(await p.visivel("#grafDica"), false, "a etiqueta devia sumir ao tocar fora (" + q + ")");
      certo(await p.avaliar((q) => { const e = document.querySelector(q); if (!e) return false; e.dispatchEvent(new PointerEvent("pointerenter")); return true; }, q), "não achei o ponto " + q);
      certo(await p.visivel("#grafDica"), "pointerenter não mostrou a etiqueta em " + q);
      const t1 = await p.texto("#grafDica");
      certo(t1.includes("R$"), "a etiqueta devia ter o valor em " + q + ": " + t1);
      await fechar();
      await p.avaliar((q) => document.querySelector(q).focus(), q);
      certo(await p.visivel("#grafDica"), "o foco não mostrou a etiqueta em " + q);
      igual(await p.texto("#grafDica"), t1, "a mesma etiqueta pelo foco em " + q);
      const rot = await p.avaliar((q) => document.querySelector(q).getAttribute("aria-label"), q);
      certo(rot && rot.includes("R$"), "o ponto devia ter o valor em texto para leitor de tela: " + rot);
    }
    // uma etiqueta só, reaproveitada
    igual(await p.avaliar(() => document.querySelectorAll("#grafDica, .n-dica").length), 1, "etiquetas na página");
    // teclado: as setas andam entre os pontos do mesmo gráfico
    await p.avaliar(() => document.querySelector("#gSeis .g-pt").focus());
    await tecla(p, "ArrowRight");
    igual(await p.avaliar(() => document.activeElement.dataset.i + "/" + document.activeElement.getAttribute("tabindex")), "1/0", "a seta para a direita vai ao próximo mês");
    igual(await p.avaliar(() => document.querySelectorAll('#gSeis [tabindex="0"]').length), 1, "só um ponto do gráfico fica no Tab");
    await p.avaliar(() => document.querySelector('#gDias .g-pt[data-dia="4"]').focus());
    await tecla(p, "ArrowDown");
    igual(await p.avaliar(() => document.activeElement.dataset.dia), "11", "no calendário, a seta para baixo desce uma semana");
    // Esc com a etiqueta aberta só fecha a etiqueta; o Esc seguinte é o de sempre (volta um passo)
    certo(await p.visivel("#grafDica"), "a etiqueta devia estar aberta no dia 11");
    await tecla(p, "Escape"); await p.espera(300);
    igual(await p.visivel("#grafDica"), false, "Esc devia fechar a etiqueta");
    igual(await p.abaAtual(), "graficos", "o Esc que fecha a etiqueta não sai dos Gráficos");
    // a barra de endereço do celular sumindo dispara resize sem mudar a largura: a etiqueta fica
    await p.avaliar(() => document.querySelector("#gSeis .g-pt").dispatchEvent(new PointerEvent("pointerenter")));
    await p.avaliar(() => window.dispatchEvent(new Event("resize"))); await p.espera(250);
    certo(await p.visivel("#grafDica"), "um resize sem mudar a largura não devia fechar a etiqueta");
    await p.tamanho(340, 780); await p.espera(250);
    igual(await p.visivel("#grafDica"), false, "mudar a largura fecha a etiqueta");
    await p.tamanho(360, 780); await p.espera(250);
    // Ritmo: os dias são estreitos demais para o dedo; o toque escolhe o dia mais próximo de onde caiu, e só a área toda recebe o toque
    const pe = await p.avaliar(() => [...document.querySelectorAll("#gRitmo .g-pt")].filter((x) => getComputedStyle(x).pointerEvents !== "none").length);
    igual(pe, 0, "os pontos estreitos do Ritmo não recebem o toque um por um");
    const dia5 = await p.avaliar(() => {
      const area = document.querySelector("#gRitmo .g-area"); if (!area) return "sem área de toque";
      const r5 = document.querySelector('#gRitmo .g-pt[data-i="4"] .g-ancora').getBoundingClientRect(), r6 = document.querySelector('#gRitmo .g-pt[data-i="5"] .g-ancora').getBoundingClientRect();
      const x = (r5.left + r5.width / 2) * 0.62 + (r6.left + r6.width / 2) * 0.38, ar = area.getBoundingClientRect(), y = ar.top + ar.height / 2;
      area.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: x, clientY: y, pointerType: "touch" }));
      return document.querySelector("#grafDica").hidden ? "etiqueta fechada" : document.querySelector("#grafDica").textContent;
    });
    certo(/^dia 5(?!\d)/.test(dia5), "tocar perto do dia 5 devia mostrar o dia 5: " + dia5);
  },
  "Gráficos de mês vazio mostram convite, sem NaN": async (p) => {
    const casos = [
      ["mês sem lançamento", { onboarded: true, guiaVisto: true, caixinhas: [{ id: "a", nome: "Casa", cor: "#9C9BF5" }], limitesPadrao: { a: 1000 } }],
      ["sem caixinhas", { onboarded: true, guiaVisto: true, caixinhas: [], limitesPadrao: {} }],
      ["caixinha sem limite", { onboarded: true, guiaVisto: true, caixinhas: [{ id: "a", nome: "Avulsos", cor: "#9C9BF5" }], limitesPadrao: { a: 0 } }],
      ["mês futuro", null],
    ];
    for (const [nome, estado] of casos) {
      if (estado) { await p.avaliar((e) => localStorage.setItem("caixinhas-orologia-v1", JSON.stringify(e)), estado); await p.recarregar(); await p.aba("graficos"); }
      else { await p.avaliar(() => localStorage.clear()); await p.recarregar(); await comExemplo(p); await p.aba("graficos"); await p.clicar('#v-graficos [data-act="mes-next"]'); }
      const r = await p.avaliar(() => {
        const v = document.querySelector("#v-graficos");
        const attrs = [...v.querySelectorAll("*")].flatMap((e) => [...e.attributes].map((a) => a.value)).filter((x) => /NaN|Infinity|undefined/.test(x));
        const cont = ["gRitmo", "gRosca", "gSeis", "gDias", "gFormas"].map((id) => { const e = document.getElementById(id); const vis = e && e.getClientRects().length > 0; return vis && !e.querySelector("svg, .n-vazio") ? id : ""; }).filter(Boolean);
        return { txt: (v.textContent.match(/.{0,30}(NaN|Infinity|undefined).{0,30}/) || [""])[0], attrs: attrs.join(" | "), vazios: cont.join(",") };
      });
      igual(r.txt, "", "texto quebrado nos Gráficos (" + nome + ")");
      igual(r.attrs, "", "atributos quebrados nos Gráficos (" + nome + ")");
      igual(r.vazios, "", "gráfico à vista sem desenho nem estado vazio (" + nome + ")");
      certo(await p.visivel("#gConvite.n-vazio"), "o convite a lançar devia aparecer (" + nome + ")");
      certo(await p.visivel('#gConvite [data-act="gasto-novo"]'), "o convite devia ter o botão de lançar (" + nome + ")");
    }
    await p.clicar('#gConvite [data-act="gasto-novo"]');
    certo(await p.visivel("#fGasto"), "o convite abre a folha de lançar");
    // sem limite não há ritmo a passar: a linha do gasto não fica na cor de alerta
    await p.avaliar(() => {
      const d = new Date(), k = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
      localStorage.setItem("caixinhas-orologia-v1", JSON.stringify({ onboarded: true, guiaVisto: true, caixinhas: [{ id: "a", nome: "Avulsos", cor: "#9C9BF5" }], limitesPadrao: { a: 0 }, meses: { [k]: { gastos: [{ id: "g1", valor: 30, descricao: "Pão", caixinha: "a", forma: "Pix", data: k + "-01" }] } } }));
    });
    await p.recarregar(); await p.aba("graficos");
    igual(await p.avaliar(() => document.querySelector("#gRitmo .ga-tot").getAttribute("stroke")), "var(--accent)", "linha do ritmo sem limite");
  },
  "Financiamento mostra o saldo devedor de SAC e PRICE": async (p) => {
    await comExemplo(p); await calc(p, "fin");
    await p.digitar("#iValor", "250000"); await p.digitar("#iEntrada", "50000"); await p.digitar("#iJuros", "12,682503"); await p.digitar("#iAnos", "20");
    await p.digitar("#iCorr", "0"); await p.digitar("#iRenda", ""); await p.digitar("#iExtra", "");
    const curvas = () => p.avaliar(() => {
      const b = document.querySelector("#finSaldo .g-base"), base = b ? Number(b.getAttribute("y1")) : NaN;
      return [...document.querySelectorAll("#finSaldo path[data-serie]")].map((c) => { const n = c.getAttribute("d").match(/-?\d+(\.\d+)?/g).map(Number); return { nome: c.dataset.serie, x: n[n.length - 2], y: n[n.length - 1], base }; });
    });
    let c = await curvas();
    certo(await p.avaliar(() => document.querySelectorAll("#finSaldo path").length) >= 2, "o gráfico do saldo devedor devia ter as duas curvas");
    igual(c.map((x) => x.nome).sort().join(","), "PRICE,SAC", "curvas sem amortização extra");
    for (const x of c) certo(Math.abs(x.y - x.base) < 0.5, "a curva " + x.nome + " devia terminar em zero: " + JSON.stringify(x));
    certo(Math.abs(c[0].x - c[1].x) < 0.5, "sem extra, as duas terminam no fim do prazo: " + JSON.stringify(c));
    await p.digitar("#iExtra", "500");
    c = await curvas();
    const por = Object.fromEntries(c.map((x) => [x.nome, x]));
    certo(por["SAC"] && por["PRICE"] && por["SAC sem extra"] && por["PRICE sem extra"], "com extra: as curvas encurtadas e as do prazo contratado: " + c.map((x) => x.nome).join(","));
    for (const x of c) certo(Math.abs(x.y - x.base) < 0.5, "a curva " + x.nome + " devia terminar em zero: " + JSON.stringify(x));
    certo(por["SAC"].x < por["SAC sem extra"].x - 5 && por["PRICE"].x < por["PRICE sem extra"].x - 5, "com extra, a curva termina antes: " + JSON.stringify(c));
    certo(await p.avaliar(() => { const e = document.querySelector("#finSaldo .g-pt"); if (!e) return false; e.dispatchEvent(new PointerEvent("pointerenter")); return true; }), "o saldo devedor devia ter pontos para tocar");
    certo((await p.texto("#grafDica")).includes("R$"), "tocar no saldo devedor mostra o valor: " + await p.texto("#grafDica"));
    await p.digitar("#iValor", "0");
    certo(!/NaN|Infinity|undefined/.test(await p.avaliar(() => document.querySelector("#finSaldo").innerHTML)), "saldo devedor quebrado sem valor");
  },
  "Gráficos novos se desenham ao entrar e terminam iguais": { movimento: true, fn: async (p) => {
    await comExemplo(p); await p.aba("graficos"); await p.espera(40);
    const ids = ["gRitmo", "gRosca", "gSeis", "gDias", "gFormas"];
    const vivas = await p.avaliar((ids) => ids.map((id) => id + ":" + document.getElementById(id).getAnimations({ subtree: true }).length), ids);
    for (const v of vivas) certo(Number(v.split(":")[1]) > 0, "o gráfico não se desenhou ao entrar: " + vivas.join(" "));
    const antes = await p.avaliar(() => document.querySelector("#v-graficos").innerHTML);
    await p.espera(2600);
    igual(await animando(p), 0, "animações que não terminaram (nada anima em laço)");
    igual(await p.avaliar(() => document.querySelector("#v-graficos").innerHTML), antes, "o desenho no fim devia ser o mesmo do começo");
    const fim = await p.avaliar(() => ({
      fatias: [...document.querySelectorAll("#gRosca .gr-fatia")].map((f) => getComputedStyle(f).strokeDashoffset).join(","),
      dias: [...document.querySelectorAll("#gDias .g-dia")].filter((c) => getComputedStyle(c).opacity !== "1").length,
      barras: [...document.querySelectorAll("#v-graficos .gb, #v-graficos .gbd")].filter((g) => getComputedStyle(g).transform !== "none").length,
    }));
    certo(/^(0px,?)+$/.test(fim.fatias), "as fatias deviam terminar inteiras: " + fim.fatias);
    igual(fim.dias, 0, "dias do calendário que não terminaram de aparecer");
    igual(fim.barras, 0, "barras que não terminaram de crescer");
    // sair e voltar desenha de novo; ficar parado não anima nada
    await p.aba("mes"); await p.aba("graficos"); await p.espera(40);
    certo((await p.avaliar(() => document.getElementById("gSeis").getAnimations({ subtree: true }).length)) > 0, "voltar aos Gráficos devia desenhar de novo");
  } },
  "Gráficos legíveis: textos sem sobrepor nem cortar, nos temas noite e dia (prints)": async (p) => {
    // meses com dados, um estourado, nome comprido de caixinha e de forma de pagamento, valores grandes
    await p.avaliar(() => {
      const pad = (n) => String(n).padStart(2, "0"), d = new Date();
      const mes = (i) => { const x = new Date(d.getFullYear(), d.getMonth() + i, 1); return x.getFullYear() + "-" + pad(x.getMonth() + 1); };
      const caixinhas = [{ id: "lazer", nome: "Lazer", cor: "#E3C98A" }, { id: "dia", nome: "Dia a dia", cor: "#9C9BF5" }, { id: "mercado", nome: "Supermercado, padaria e feiras", cor: "#8FD3B4" }, { id: "obj", nome: "Objetivos", cor: "#C9A6F5" }];
      const formas = ["Pix", "Crédito", "Débito", "Vale-refeição do trabalho", "Dinheiro"];
      const meses = {}; let n = 0;
      for (let i = -5; i <= 0; i++) {
        const k = mes(i), fator = i === -2 ? 1.6 : i === 0 ? 1.25 : 0.7 + (i + 5) * 0.05, ate = i === 0 ? Math.max(1, d.getDate()) : 28;
        const gastos = [];
        for (let j = 0; j < 14; j++) gastos.push({ id: "g" + n++, valor: Math.round((20 + ((j * 37) % 140)) * fator * 100) / 100 * (j === 3 && (i === 0 || i === -2) ? 12 : 1), descricao: "Gasto " + j, caixinha: caixinhas[j % 4].id, forma: formas[j % 5], data: k + "-" + pad(1 + ((j * 5) % ate)) });
        meses[k] = { gastos };
      }
      localStorage.setItem("caixinhas-orologia-v1", JSON.stringify({ onboarded: true, guiaVisto: true, caixinhas, limitesPadrao: { lazer: 700, dia: 500, mercado: 900, obj: 300 }, meses }));
    });
    const ruins = (sel) => p.avaliar((sel) => {
      const saida = [];
      document.querySelectorAll(sel + " svg.n-graf-d").forEach((s) => {
        if (!s.getClientRects().length) return;
        const caixa = s.getBoundingClientRect(), dono = s.closest("[id]").id;
        const ts = [...s.querySelectorAll("text")].filter((t) => t.textContent.trim() && getComputedStyle(t).visibility !== "hidden").map((t) => ({ t: t.textContent, r: t.getBoundingClientRect() }));
        ts.forEach((a, i) => {
          if (a.r.left < caixa.left - 1 || a.r.right > caixa.right + 1 || a.r.top < caixa.top - 1 || a.r.bottom > caixa.bottom + 1) saida.push(dono + ": \"" + a.t + "\" sai da caixa");
          ts.slice(i + 1).forEach((b) => { const w = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left), h = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top); if (w > 1 && h > 1) saida.push(dono + ": \"" + a.t + "\" cobre \"" + b.t + "\""); });
        });
      });
      document.querySelectorAll(sel + " .n-legenda li, " + sel + " .n-vazio").forEach((li) => { if (li.getClientRects().length && li.scrollWidth > li.clientWidth + 1) saida.push("legenda estoura: " + li.textContent.trim()); });
      return saida;
    }, sel);
    const larga = () => p.avaliar(() => { const s = document.createElement("style"); s.id = "fonteLarga"; s.textContent = ".n-graf text,.n-legenda{letter-spacing:.06em}"; document.head.appendChild(s); });
    for (const tema of ["noite", "dia"]) {
      await p.avaliar((tema) => localStorage.setItem("caixinhas-orologia-tema", JSON.stringify({ atual: tema, meus: [] })), tema);
      for (const [w, h] of [[360, 780], [320, 640], [1280, 800]]) {
        await p.tamanho(w, h); await p.recarregar();
        for (const [caso, ir] of [["estourado", null], ["anterior", "mes-prev"], ["vazio", "mes-next"]]) {
          await p.aba("graficos"); await p.clicar('#v-graficos [data-act="mes-hoje"]');
          if (ir) await p.clicar('#v-graficos [data-act="' + ir + '"]');
          if (w === 320) await larga(); // a fonte do Linux é mais larga: os textos precisam de folga
          const sobra = await p.avaliar(() => document.documentElement.scrollWidth - innerWidth);
          certo(sobra <= 0, `os Gráficos passam ${sobra}px da largura em ${w}px (${caso}, ${tema})`);
          const r = await ruins("#v-graficos");
          igual(r.join(" | "), "", `textos dos Gráficos em ${w}px (${caso}, ${tema})`);
          // o último dia do mês tem rótulo embaixo do Ritmo (quando falta lugar, sai o 28, não o último)
          const ult = await p.avaliar(() => { const n = document.querySelector("#gRitmo")._graf.op.rotulos.length; return { n, tem: [...document.querySelectorAll("#gRitmo svg.n-graf-d text")].some((t) => t.textContent.trim() === String(n)) }; });
          certo(ult.tem, `o rótulo do último dia (${ult.n}) sumiu do Ritmo em ${w}px (${caso}, ${tema})`);
          // na comparação com o mês anterior, o sinal não fica sozinho numa linha
          const quebra = await p.avaliar(() => [...document.querySelectorAll("#gCompBox .cmp-h .num")].filter((e) => { const rg = document.createRange(); rg.selectNodeContents(e); return new Set([...rg.getClientRects()].map((r) => Math.round(r.top))).size > 1; }).map((e) => e.textContent));
          igual(quebra.join(" | "), "", `diferença da comparação quebrada em duas linhas em ${w}px (${caso}, ${tema})`);
          await p.print(`22-graficos-${caso}-${tema}-${w}`, true);
        }
        await calc(p, "fin"); await p.digitar("#iExtra", "800");
        if (w === 320) await larga();
        igual((await ruins("#c-fin")).join(" | "), "", `textos do saldo devedor em ${w}px (${tema})`);
        await p.avaliar(() => document.querySelector("#finSaldo").scrollIntoView({ block: "center" }));
        await p.print(`22-financiamento-${tema}-${w}`);
        await p.digitar("#iExtra", "");
        await p.aba("cartao"); igual((await ruins("#v-cartao")).join(" | "), "", `textos das próximas faturas em ${w}px (${tema})`);
        await calc(p, "sim"); igual((await ruins("#c-sim")).join(" | "), "", `textos do simulador em ${w}px (${tema})`);
        await p.aba("inicio"); igual((await ruins("#v-inicio")).join(" | "), "", `textos dos gráficos do Início em ${w}px (${tema})`);
        if (w === 1280) {
          certo(await p.visivel("#seisIni svg"), "no PC o Início mostra os últimos 6 meses");
          await p.print(`22-inicio-pc-${tema}`, true);
        }
      }
    }
  },
  "Cartões: avisa que não se digita dado do cartão": async (p) => {
    await p.aba("cartao");
    certo((await p.texto("#ktAviso")).includes("nunca pede número, validade nem código de segurança"), "faltou o aviso no cadastro de cartões");
    certo((await p.texto('label:has(#ktNome)')).startsWith("Apelido do cartão"), "o campo devia pedir um apelido");
    await p.aba("ajustes");
    certo((await p.texto("#bkpDica")).includes("Crie uma pasta só para isso"), "faltou a dica de criar uma pasta para o backup");
  },
  "Leitor de tela ouve os valores atuais no Início": async (p) => {
    await comExemplo(p);
    const rotulo = () => p.avaliar(() => document.querySelector('#inCx .n-bloco[data-cx="lazer"]').getAttribute("aria-label").replace(/\s+/g, " "));
    igual(await rotulo(), "Lazer: sobra R$ 520,10 de R$ 700,00", "rótulo do Lazer");
    const dial = await p.avaliar(() => document.querySelector("#inResumo #arco").getAttribute("aria-label"));
    certo(/^18% do limite do mês gasto, com \d+% do mês passado$/.test(dial), "rótulo do arco: " + dial);
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
    igual(await p.texto("#inSobra"), "R$ 850,00", "sobra com o gasto órfão");
    await p.aba("mes");
    await p.clicar('#mesLista .n-lanc[data-id="g2"]'); await p.clicar("#gApagar"); await p.clicar("#gApagar");
    await p.aba("inicio");
    igual(await p.texto("#inSobra"), "R$ 950,00", "sobra depois de apagar o gasto órfão");
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
    igual(await p.texto("#inSobra"), "R$ 1.230,70", "sobra pronta, sem contar");
    for (const t of ["inicio", "cartao", "metas", "mes", "graficos"]) {
      await p.aba(t); if (t === "graficos") await p.clicar('#v-graficos [data-act="mes-prev"]'); // trocar o mês redesenha os gráficos
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
  "Início avisa o que vence nos próximos 7 dias": async (p) => {
    await semearContas(p);
    await p.recarregar();
    const t = await p.texto("#inVencer");
    certo(t.includes("A vencer"), "o cartão A vencer não apareceu: " + t);
    certo(/Fatura Nubank.*amanhã.*R\$ 44,90/.test(t), "fatura de amanhã com o total do cartão: " + t);
    certo(/Internet.*em 3 dias.*R\$ 100,00/.test(t), "gasto fixo em 3 dias: " + t);
    certo(t.indexOf("Fatura Nubank") < t.indexOf("Internet"), "a ordem é pela data: " + t);
    certo(!t.includes("Netflix"), "fixo no crédito não entra (já está na fatura): " + t);
    certo(!t.includes("Academia"), "fixo apagado neste mês não entra: " + t);
    certo(!t.includes("Seguro"), "o que vence depois de 7 dias não entra: " + t);
    certo(/Fatura Vazio · em 2 dias(?!\s*R\$)/.test(t.replace(/\s+/g, " ")) && !/Fatura Vazio[^F]*R\$ 0/.test(t), "cartão sem compras cadastradas avisa o vencimento, sem valor: " + t);
    await p.print("13-a-vencer");
  },
  "Sem nada a vencer, o cartão A vencer não aparece": async (p) => {
    await p.avaliar(() => { localStorage.setItem("caixinhas-orologia-v1", JSON.stringify({ onboarded: true, caixinhas: [{ id: "a", nome: "Tudo", cor: "#9C9BF5" }], limitesPadrao: { a: 100 } })); });
    await p.recarregar();
    igual(await p.visivel("#inVencer"), false, "cartão A vencer sem contas");
  },
  "Ajustes abre numa lista de partes e mostra uma por vez": async (p) => {
    await comExemplo(p); await p.aba("ajustes");
    igual(await p.avaliar(() => [...document.querySelectorAll("#ajMenu [data-parte]")].map((b) => b.dataset.parte).join(",")), "caixinhas,pagamento,aparencia,pin,dados,lembretes,sobre", "partes dos Ajustes");
    igual(await p.visivel("#cxList"), false, "na lista, nenhuma parte fica aberta");
    await p.print("14-ajustes-lista");
    await p.clicar('#ajMenu [data-parte="aparencia"]');
    igual(await p.avaliar(() => location.hash), "#ajustes/aparencia", "o endereço guarda a parte");
    certo(await p.visivel("#temaBox"), "a parte Aparência devia aparecer");
    igual(await p.visivel("#cxList"), false, "só uma parte por vez");
    igual(await p.visivel("#ajMenu"), false, "a lista some quando uma parte abre");
    // a parte aberta é dita também ao leitor de tela (no PC a lista fica à vista ao lado), não só pela cor
    igual(await p.avaliar(() => [...document.querySelectorAll('#ajMenu [aria-current="true"]')].map((b) => b.dataset.parte).join(",")), "aparencia", "item da parte aberta marcado com aria-current");
    await p.print("14-ajustes-parte");
    await p.recarregar();
    certo(await p.visivel("#temaBox"), "recarregar mantém a parte aberta");
    await p.clicar("#ajVoltar");
    certo(await p.visivel("#ajMenu"), "voltar mostra a lista");
    igual(await p.avaliar(() => document.querySelectorAll('#ajMenu [aria-current]').length), 0, "na lista, nenhuma parte marcada como aberta");
    igual(await p.avaliar(() => location.hash), "#ajustes", "endereço da lista");
    await p.clicar('#ajMenu [data-parte="pin"]');
    await p.avaliar(() => history.back()); await p.espera(200);
    certo(await p.visivel("#ajMenu"), "o voltar do aparelho fecha a parte e mostra a lista");
    await p.aba("mes"); await p.clicar('[data-go="ajustes/caixinhas"]');
    certo(await p.visivel("#cxList"), "o atalho Editar caixinhas abre direto a parte Caixinhas");
    await p.digitar("#cxn-0", "Nome em edição"); await p.clicar("#ajVoltar"); await p.clicar('#ajMenu [data-parte="caixinhas"]');
    igual(await p.avaliar(() => document.querySelector("#cxn-0").value), "Nome em edição", "voltar para a lista não descarta a edição das caixinhas");
    await p.aba("ajustes/lembretes");
    certo((await p.texto("#lembBox")).includes("A vencer"), "parte Lembretes: " + await p.texto("#lembBox"));
    await p.tamanho(900, 800); await p.aba("ajustes"); await p.print("14-ajustes-pc");
  },
  "No site nada de Android aparece": async (p) => {
    await comExemplo(p); await p.aba("ajustes/lembretes");
    igual(await p.avaliar(() => !!document.querySelector("#lembLigar")), false, "controle de notificação fora do app");
    igual(await p.avaliar(() => document.documentElement.classList.contains("nativo")), false, "marca de app no site");
    certo(!(await p.avaliar(() => document.querySelector('meta[name="viewport"]').content)).includes("user-scalable=no"), "o zoom continua livre no site");
  },
  "Android: voltar fecha uma coisa por vez e sai do app no Início": { nativo: true, fn: async (p) => {
    await comExemplo(p);
    certo((await p.avaliar(() => document.querySelector('meta[name="viewport"]').content)).includes("user-scalable=no"), "zoom de pinça bloqueado no app");
    const voltar = async () => { await p.avaliar(() => { window.__nativo.voltar(); }); await p.espera(350); };
    await p.aba("mes"); await p.clicar("#fab");
    certo(await p.visivel("#folhaGasto"), "a folha de lançar abriu");
    await voltar();
    igual(await p.visivel("#folhaGasto"), false, "o primeiro voltar fecha só a folha");
    igual(await p.abaAtual(), "mes", "e continua na aba Mês");
    await p.aba("ajustes"); await p.clicar('#ajMenu [data-parte="pin"]');
    await voltar();
    certo(await p.visivel("#ajMenu"), "voltar fecha a parte dos Ajustes");
    await voltar(); await voltar();
    igual(await p.abaAtual(), "inicio", "voltando chega ao Início");
    igual(await p.avaliar(() => window.__nativo.minimizou), 0, "ainda não saiu do app");
    await voltar();
    igual(await p.avaliar(() => window.__nativo.minimizou), 1, "no Início, voltar sai do app");
    await p.aba("ajustes/pin"); await p.avaliar(() => { history.back = () => {}; }); // app reaberto numa aba, sem histórico: o voltar do navegador não faz nada
    await voltar();
    certo(await p.visivel("#ajMenu"), "sem histórico, voltar sobe da parte para a lista de Ajustes");
    await voltar();
    igual(await p.abaAtual(), "inicio", "sem histórico, voltar leva ao Início");
    await p.aba("ajustes/sobre");
    igual(await p.visivel("#atalhosTec"), false, "no app Android a linha dos atalhos de teclado não aparece");
  } },
  "Android: backup, planilha e cópias saem pelo compartilhamento": { nativo: true, fn: async (p) => {
    await comExemplo(p); await p.aba("ajustes/dados");
    const ultima = () => p.avaliar(() => { const c = window.__nativo.chamadas.filter((x) => x[0] === "compartilhar").pop(); return c ? { nome: c[1].nome, tipo: c[1].tipo, tem: String(c[1].texto).slice(0, 4000) } : null; });
    await p.clicar('[data-act="exp"]'); await p.espera(200);
    let c = await ultima();
    igual(await p.visivel("#expShare"), false, "no app sobra um caminho de envio só (o compartilhamento do Android)");
    igual(await p.avaliar(() => document.querySelector('a[href="privacy.html"]').getAttribute("target")), null, "a política de privacidade abre dentro do app, não num navegador sem acesso aos arquivos");
    certo(c && /^caixinhas-backup-\d{4}-\d{2}-\d{2}\.json$/.test(c.nome) && c.tipo === "application/json" && c.tem.includes("caixinhas-orologia"), "backup compartilhado: " + JSON.stringify(c).slice(0, 200));
    igual(await p.texto("#expBox"), "", "sem a caixa de 'o download não começou' no app");
    igual(await p.avaliar(() => localStorage.getItem("caixinhas-orologia-backup")), null, "abrir o compartilhamento não conta como backup feito (a pessoa pode cancelar)");
    await p.clicar('[data-act="csv-tudo"]'); await p.espera(200);
    c = await ultima();
    certo(c && c.nome.endsWith(".csv") && c.tipo.includes("csv") && c.tem.includes("Mercado da semana"), "planilha compartilhada: " + JSON.stringify(c).slice(0, 200));
  } },
  "Android: pasta com cópias de outro aparelho pergunta antes e nunca as apaga": { nativo: true, fn: async (p) => {
    const outro = "caixinhas-backup-2026-01-01-zzzz.json";
    await p.avaliar((outro) => {
      const d = new Date(), mes = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
      localStorage.setItem("caixinhas-orologia-v1", JSON.stringify({ onboarded: true, guiaVisto: true, caixinhas: [{ id: "a", nome: "Tudo", cor: "#9C9BF5" }], limitesPadrao: { a: 500 },
        meses: { [mes]: { gastos: [{ id: "g1", valor: 30, descricao: "Pão", caixinha: "a", forma: "Pix", data: mes + "-01" }] } } }));
      const antigo = { app: "caixinhas-orologia", caixinhas: [{ id: "a", nome: "Tudo", cor: "#9C9BF5" }], limitesPadrao: { a: 500 }, meses: { "2026-01": { gastos: [{ id: "x", valor: 7, descricao: "Antigo", caixinha: "a", forma: "Pix", data: "2026-01-01" }, { id: "y", valor: 8, descricao: "Antigo 2", caixinha: "a", forma: "Pix", data: "2026-01-02" }] } } };
      localStorage.setItem("__pasta", JSON.stringify({ [outro]: JSON.stringify(antigo), "outra-coisa.txt": "x" }));
      localStorage.setItem("caixinhas-orologia-aparelho", JSON.stringify("zzzz")); // celular novo que herdou os dados (e a marca) do antigo pela restauração do Android
    }, outro);
    await p.recarregar(); await p.aba("ajustes/dados");
    const gravacoes = () => p.avaliar(() => window.__nativo.chamadas.filter((x) => x[0] === "gravarBackup").map((x) => x[1]));
    await p.clicar('[data-act="bkp-pasta"]'); await p.espera(300);
    certo((await p.texto("#bkpBox")).includes("já tem uma cópia"), "devia avisar que a pasta já tem cópias: " + await p.texto("#bkpBox"));
    certo((await p.texto("#bkpBox")).includes("de outro aparelho"), "a cópia é de outro aparelho: " + await p.texto("#bkpBox"));
    igual((await gravacoes()).length, 0, "nada é gravado antes da resposta");
    await p.clicar('[data-act="bkp-usar"]'); await p.espera(400);
    const g = await gravacoes();
    igual(g.length, 1, "gravações depois de aceitar a pasta");
    certo(/^caixinhas-backup-\d{4}-\d{2}-\d{2}-[a-z0-9]{4}\.json$/.test(g[0].nome) && g[0].nome.endsWith(g[0].grupo) && g[0].grupo === "-tst1.json" && g[0].manter === 7, "nome com a marca do aparelho: " + JSON.stringify(g[0]));
    certo(await p.avaliar((outro) => outro in JSON.parse(localStorage.getItem("__pasta")), outro), "a cópia do outro aparelho foi apagada");
    await p.recarregar(); await p.aba("ajustes/dados");
    certo((await p.texto("#bkpBox")).includes("Gravando na pasta “Backup”"), "a pasta continua escolhida depois de reabrir: " + await p.texto("#bkpBox"));
    await p.clicar('[data-act="bkp-ver"]'); await p.espera(300);
    igual(await p.avaliar(() => document.querySelectorAll('#bkpBox [data-act="bkp-doc"]').length), 2, "cópias da pasta (a deste aparelho e a do outro; outros arquivos não contam)");
    await p.avaliar((outro) => [...document.querySelectorAll('[data-act="bkp-doc"]')].find((b) => b.dataset.id === outro).click(), outro); await p.espera(300);
    certo((await p.texto("#impConfirm")).includes("Backup com 2 gastos"), "restaurar a cópia escolhida pede confirmação: " + await p.texto("#impConfirm"));
    await p.clicar('[data-act="bkp-parar"]'); await p.espera(300); await p.recarregar(); await p.aba("ajustes/dados");
    certo(!(await p.texto("#bkpBox")).includes("Gravando na pasta"), "parar de usar a pasta vale depois de reabrir");
  } },
  "Android: lembretes pedem permissão só ao ligar e não mostram valores": { nativo: true, fn: async (p) => {
    await semearContas(p); await p.recarregar(); await p.espera(1000);
    const N = () => p.avaliar(() => ({ pediu: window.__nativo.pediu, ag: window.__nativo.agendadas }));
    igual((await N()).pediu, 0, "abrir o app não pede permissão");
    igual((await N()).ag.length, 0, "nada agendado com o lembrete desligado");
    await p.aba("ajustes/lembretes");
    const marcar = async (v) => { await p.avaliar((v) => { const c = document.querySelector("#lembLigar"); c.checked = v; c.dispatchEvent(new Event("change", { bubbles: true })); }, v); await p.espera(400); };
    await marcar(true);
    let n = await N();
    igual(n.pediu, 1, "a permissão é pedida ao ligar");
    certo(n.ag.length >= 2, "notificações agendadas: " + n.ag.length);
    igual(new Set(n.ag.map((x) => x.id)).size, n.ag.length, "uma notificação por dia, sem repetir");
    certo(n.ag.every((x) => x.at > Date.now()), "nada agendado para o passado");
    certo(n.ag.some((x) => x.body === "Vence amanhã: Internet"), "aviso do gasto fixo, 1 dia antes: " + n.ag.map((x) => x.body).join(" | "));
    certo(n.ag.some((x) => x.body.includes("Fatura Nubank")), "aviso da fatura: " + n.ag.map((x) => x.body).join(" | "));
    certo(!n.ag.some((x) => /R\$|Netflix|\d,\d\d/.test(x.body)), "sem valores nem contas que não entram: " + n.ag.map((x) => x.body).join(" | "));
    const d9 = n.ag.find((x) => x.body === "Vence amanhã: Internet"); igual(new Date(d9.at).getHours(), 9, "hora padrão");
    await p.avaliar(() => { const s = document.querySelector("#lembAntes"); s.value = "0"; s.dispatchEvent(new Event("change", { bubbles: true })); }); await p.espera(400);
    n = await N();
    certo(n.ag.some((x) => x.body === "Vence hoje: Internet") && !n.ag.some((x) => x.body.includes("amanhã")), "mudar a antecedência refaz os avisos: " + n.ag.map((x) => x.body).join(" | "));
    await p.recarregar(); await p.espera(1200);
    certo((await N()).ag.length >= 2, "ao reabrir o app os avisos são refeitos");
    await p.aba("ajustes/lembretes");
    igual(await p.avaliar(() => document.querySelector("#lembLigar").checked), true, "o lembrete continua ligado");
    await marcar(false);
    igual((await N()).ag.length, 0, "desligar cancela os avisos");
    await p.avaliar(() => { localStorage.removeItem("__perm"); window.__nativo.responder = "denied"; });
    await marcar(true);
    igual(await p.avaliar(() => document.querySelector("#lembLigar").checked), false, "sem permissão, o controle volta para desligado");
    certo((await p.texto("#lembEstado")).includes("não deixou"), "explica como liberar: " + await p.texto("#lembEstado"));
    igual((await N()).ag.length, 0, "sem permissão, nada é agendado");
    await p.print("15-lembretes-android");
  } },
  "PC: barra lateral no lugar da barra de baixo": async (p) => {
    await comExemplo(p);
    await p.tamanho(1280, 800); await p.recarregar();
    certo(await p.visivel("#lado"), "a barra lateral não apareceu em 1280");
    certo(!(await p.visivel(".tabs")), "a barra de baixo devia sumir em 1280");
    igual(await p.avaliar(() => [...document.querySelectorAll("#lado a[data-tab]")].map((a) => a.dataset.tab).join(",")), "inicio,mes,graficos,cartao,metas,calc,ajustes", "entradas da barra lateral");
    certo(await p.visivel('#lado #ladoLancar[data-act="gasto-novo"]'), "o + Lançar da barra lateral não apareceu");
    const atual = () => p.avaliar(() => [...document.querySelectorAll('#lado a[aria-current="page"]')].map((a) => a.dataset.tab).join(","));
    igual(await atual(), "inicio", "Início marcado na barra lateral");
    // no PC o Tab passa pela barra lateral antes do conteúdo
    certo(await p.avaliar(() => !!(document.querySelector("#lado").compareDocumentPosition(document.querySelector(".wrap")) & Node.DOCUMENT_POSITION_FOLLOWING)), "a barra lateral devia vir antes do conteúdo no HTML (ordem do Tab)");
    // o conteúdo começa depois da barra, sem ficar por baixo dela
    const m = await p.avaliar(() => ({ lado: document.querySelector("#lado").getBoundingClientRect().right, cont: document.querySelector("#v-inicio").getBoundingClientRect().left }));
    certo(m.cont >= m.lado, `o conteúdo começa em ${m.cont}px, embaixo da barra lateral (que vai até ${m.lado}px)`);
    await p.clicar('#lado a[data-tab="graficos"]');
    igual(await p.abaAtual(), "graficos", "Gráficos pela barra lateral");
    igual(await atual(), "graficos", "Gráficos marcado na barra lateral");
    await p.clicar('#lado a[data-tab="calc"]');
    igual(await p.abaAtual(), "calc", "Calculadoras pela barra lateral");
    igual(await atual(), "calc", "Calculadoras marcadas na barra lateral");
    igual(await p.avaliar(() => document.querySelector('.tabs a[aria-current="page"]')?.dataset.tab), "inicio", "na barra de baixo as Calculadoras continuam acendendo o Início");
    await p.aba("ajustes/pin");
    igual(await atual(), "ajustes", "Ajustes marcado na barra lateral, também numa parte");
    await p.aba("guia");
    igual(await atual(), "inicio", "o Como usar acende o Início");
    await p.clicar("#ladoLancar");
    certo(await p.visivel("#folhaGasto"), "o + Lançar da barra lateral devia abrir a folha");
    await p.clicar('.folha-topo [data-act="folha-fechar"]');
    await p.tamanho(360, 780); await p.espera(150);
    certo(!(await p.visivel("#lado")), "a barra lateral devia sumir no celular");
    certo(await p.visivel(".tabs"), "a barra de baixo devia voltar no celular");
  },
  "PC: Início em duas colunas, sem passar da largura": async (p) => {
    await comExemplo(p);
    // no celular a ordem continua a de uma coluna: arco, caixinhas, ritmo, A vencer/fatura/metas, últimos gastos, atalhos
    const tops = () => p.avaliar(() => Object.fromEntries(["inResumo", "inCx", "inRitmo", "inFatura", "inMetas", "inUltimos"].map((id) => [id, Math.round(document.getElementById(id).getBoundingClientRect().top)]).concat([["atalhos", Math.round(document.querySelector("#v-inicio .atalhos").getBoundingClientRect().top)]])));
    const t360 = await tops();
    certo(t360.inResumo < t360.inCx && t360.inCx < t360.inRitmo && t360.inRitmo < t360.inFatura && t360.inFatura < t360.inMetas && t360.inMetas < t360.inUltimos && t360.inUltimos < t360.atalhos, "ordem do Início no celular: " + JSON.stringify(t360));
    igual(await p.visivel("#seisIni"), false, "no celular o Últimos 6 meses fica só nos Gráficos");
    // a ordem de leitura (Tab, TalkBack) é a mesma que se vê: no celular, uma coluna; no PC, a coluna da esquerda e depois a da direita
    const ordemHTML = () => p.avaliar(() => {
      const els = ["inResumo", "inCx", "inRitmo", "seisIni", "inVencer", "inFatura", "inMetas", "inUltimos"].map((id) => document.getElementById(id)).concat([document.querySelector("#v-inicio .atalhos")]);
      return els.slice().sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1)).map((e) => e.id || "atalhos").join(",");
    });
    igual(await ordemHTML(), "inResumo,inCx,inRitmo,seisIni,inVencer,inFatura,inMetas,inUltimos,atalhos", "ordem de leitura do Início no celular");
    await p.tamanho(1280, 800); await p.recarregar();
    igual(await ordemHTML(), "inResumo,inRitmo,seisIni,atalhos,inCx,inVencer,inUltimos,inFatura,inMetas", "ordem de leitura do Início no PC (esquerda, depois direita)");
    certo(await p.avaliar(() => !!document.querySelector("#v-inicio .n-cols")), "o Início devia ter o contêiner de colunas .n-cols");
    const r = await p.avaliar(() => { const a = document.querySelector("#arco").getBoundingClientRect(), c = document.querySelector("#inCx").getBoundingClientRect(); return { aL: a.left, aT: a.top, cL: c.left, cT: c.top }; });
    certo(r.cL - r.aL > 200, "o arco e as caixinhas deviam ficar lado a lado: " + JSON.stringify(r));
    certo(Math.abs(r.aT - r.cT) < 80, "o arco e as caixinhas deviam começar na mesma altura: " + JSON.stringify(r));
    // coluna esquerda: arco, ritmo, últimos 6 meses; direita: caixinhas, A vencer, últimos gastos
    const col = await p.avaliar(() => Object.fromEntries(["inResumo", "inRitmo", "seisIni", "inCx", "inVencer", "inUltimos"].map((id) => { const e = document.getElementById(id); return [id, e ? e.parentElement.dataset.col || "" : "falta"]; })));
    igual(JSON.stringify(col), JSON.stringify({ inResumo: "esq", inRitmo: "esq", seisIni: "esq", inCx: "dir", inVencer: "dir", inUltimos: "dir" }), "colunas do Início");
    certo(await p.visivel("#seisIni svg[role='img']"), "no PC o Início mostra os Últimos 6 meses");
    igual(await p.avaliar(() => document.querySelectorAll("#seisIni .gb").length), 6, "seis barras, uma por mês");
    // no PC as caixinhas ficam em grade, sem rolar de lado
    const g = await p.avaliar(() => { const b = [...document.querySelectorAll("#inCx .n-bloco")].map((x) => x.getBoundingClientRect()); const f = document.querySelector("#inCx .n-blocos"); return { linhas: new Set(b.map((x) => Math.round(x.top))).size, rola: f.scrollWidth > f.clientWidth + 1 }; });
    certo(g.linhas >= 2 && !g.rola, "as caixinhas deviam ficar em grade no PC: " + JSON.stringify(g));
    for (const [w, h] of [[900, 700], [1280, 800], [1920, 1080]]) {
      await p.tamanho(w, h); await p.recarregar();
      const s = await p.avaliar(() => ({ sobra: document.documentElement.scrollWidth - innerWidth, wrap: document.querySelector(".wrap").getBoundingClientRect().width }));
      certo(s.sobra <= 0, `o Início passa ${s.sobra}px da largura em ${w}px`);
      certo(s.wrap <= 1100.5, `o conteúdo devia ir até 1100px e tem ${s.wrap}px em ${w}px`);
      await p.print(`21-inicio-pc-${w}`);
    }
  },
  "Atalhos: N lança, / busca, números trocam de aba": async (p) => {
    await comExemplo(p);
    await p.tamanho(1280, 800); await p.recarregar();
    await p.aba("ajustes/sobre");
    const linha = await p.texto("#atalhosTec");
    certo(await p.visivel("#atalhosTec") && /Atalhos de teclado/.test(linha) && /\bN\b/.test(linha) && /Esc/.test(linha) && /1/.test(linha) && /5/.test(linha), "Ajustes › Sobre lista os atalhos: " + linha);
    await p.aba("inicio");
    igual(await tecla(p, "n"), false, "o N devia ser tratado pelo app");
    certo(await p.visivel("#folhaGasto"), "N devia abrir a folha de lançar");
    igual(await p.avaliar(() => document.querySelector("#gHead").textContent), "Lançar gasto", "a folha abre para um gasto novo");
    await p.espera(100);
    await tecla(p, "Escape"); await p.espera(150);
    certo(!(await p.visivel("#folhaGasto")), "Esc devia fechar a folha");
    igual(await p.abaAtual(), "inicio", "fechar a folha não troca de aba");
    igual(await tecla(p, "/"), false, "a barra não devia ser digitada no campo");
    igual(await p.abaAtual(), "mes", "/ leva ao Mês");
    igual(await p.avaliar(() => document.activeElement && document.activeElement.id), "fBusca", "/ põe o foco na busca");
    igual(await p.avaliar(() => document.querySelector("#fBusca").value), "", "a busca começa vazia");
    await p.avaliar(() => document.activeElement.blur());
    for (const [k, aba] of [["3", "graficos"], ["4", "cartao"], ["5", "metas"], ["2", "mes"], ["1", "inicio"]]) {
      await tecla(p, k);
      igual(await p.abaAtual(), aba, `a tecla ${k}`);
    }
    await tecla(p, "4"); await tecla(p, "5");
    await tecla(p, "Escape"); await p.espera(350);
    igual(await p.abaAtual(), "cartao", "Esc fora da folha volta um passo");
    await tecla(p, "N");
    certo(await p.visivel("#folhaGasto"), "N maiúsculo (Caps Lock) também lança");
  },
  "Atalhos não disparam na hora errada": async (p) => {
    await comExemplo(p);
    await p.tamanho(1280, 800); await p.recarregar();
    // digitando num campo: a tecla é do campo
    await p.clicar("#ladoLancar"); await p.espera(100);
    await p.avaliar(() => document.querySelector("#gDesc").focus());
    igual(await tecla(p, "n"), true, "o n digitado em O que foi não pode ser engolido");
    igual(await tecla(p, "2"), true, "o 2 digitado em O que foi não pode ser engolido");
    igual(await tecla(p, "/"), true, "a / digitada em O que foi não pode ser engolida");
    certo(await p.visivel("#folhaGasto"), "a folha devia continuar aberta");
    igual(await p.abaAtual(), "inicio", "digitar num campo não troca de aba");
    // com a folha aberta e o foco fora dos campos: só o Esc age
    await p.avaliar(() => document.activeElement.blur());
    await tecla(p, "2"); await tecla(p, "/");
    igual(await p.abaAtual(), "inicio", "com a folha aberta os números não trocam de aba");
    await tecla(p, "Escape"); await p.espera(150);
    certo(!(await p.visivel("#folhaGasto")), "Esc fecha a folha");
    // dentro da folha, Esc com o foco num campo continua fechando a folha
    await p.clicar("#ladoLancar"); await p.espera(100);
    await p.avaliar(() => document.querySelector("#gDesc").focus());
    await tecla(p, "Escape"); await p.espera(150);
    certo(!(await p.visivel("#folhaGasto")), "Esc com o foco em O que foi fecha a folha");
    igual(await p.abaAtual(), "inicio", "fechar a folha pelo Esc não troca de aba");
    // Ctrl, Alt e Meta: são do navegador (Ctrl+N abre janela, Alt+1 troca de aba do navegador)
    for (const mod of ["ctrlKey", "altKey", "metaKey"]) {
      igual(await tecla(p, "n", { [mod]: true }), true, `${mod}+N não devia ser engolido`);
      await tecla(p, "2", { [mod]: true });
    }
    certo(!(await p.visivel("#folhaGasto")), "Ctrl/Alt/Meta+N não devia abrir a folha");
    igual(await p.abaAtual(), "inicio", "Ctrl/Alt/Meta+2 não devia trocar de aba");
    // outros campos: busca, lista de escolha, texto editável
    await p.aba("mes");
    await p.avaliar(() => document.querySelector("#fBusca").focus());
    await tecla(p, "1"); await tecla(p, "n");
    igual(await p.abaAtual(), "mes", "digitar na busca não troca de aba");
    certo(!(await p.visivel("#folhaGasto")), "digitar n na busca não abre a folha");
    // Esc num campo fora da folha só tira o foco; o segundo Esc volta um passo
    await tecla(p, "Escape"); await p.espera(350);
    igual(await p.abaAtual(), "mes", "Esc na busca não sai do Mês");
    certo(await p.avaliar(() => document.activeElement !== document.querySelector("#fBusca")), "Esc na busca devia tirar o foco do campo");
    await tecla(p, "Escape"); await p.espera(350);
    igual(await p.abaAtual(), "inicio", "o segundo Esc volta um passo");
    await p.aba("mes");
    await p.avaliar(() => document.querySelector("#fBusca").focus());
    await p.avaliar(() => document.querySelector("#fCx").focus());
    await tecla(p, "3");
    igual(await p.abaAtual(), "mes", "uma tecla numa lista de escolha não troca de aba");
    // caixa de marcar não é campo de texto: com o foco nela os atalhos continuam valendo
    await p.avaliar(() => document.querySelector("#fTodos").focus());
    igual(await tecla(p, "3"), false, "com o foco numa caixa de marcar, o 3 é atalho");
    igual(await p.abaAtual(), "graficos", "com o foco numa caixa de marcar, o 3 vai aos Gráficos");
    await p.aba("mes");
    await p.avaliar(() => { const d = document.createElement("div"); d.id = "editavel"; d.contentEditable = "true"; d.textContent = "x"; document.querySelector("#v-mes").append(d); d.focus(); });
    await tecla(p, "1"); await tecla(p, "n");
    igual(await p.abaAtual(), "mes", "digitar num texto editável não troca de aba");
    certo(!(await p.visivel("#folhaGasto")), "digitar num texto editável não abre a folha");
    await p.avaliar(() => { document.querySelector("#editavel").remove(); document.activeElement.blur(); });
    // com o PIN na frente: nada passa por trás da trava
    await p.aba("ajustes");
    await p.digitar("#pinNovo", "1234"); await p.digitar("#pinRep", "1234"); await p.clicar('[data-pin="ativar"]');
    await p.espera(200);
    await p.clicar('[data-pin="agora"]');
    certo(await p.avaliar(() => document.documentElement.hasAttribute("data-trava")), "o app devia estar travado");
    await p.avaliar(() => document.activeElement && document.activeElement.blur());
    // os números antes do N (com a folha aberta eles já seriam barrados por ela); a folha é conferida pelo atributo,
    // porque atrás da trava ela fica invisível mesmo aberta
    await tecla(p, "1"); await tecla(p, "/");
    igual(await p.abaAtual(), "ajustes", "com o PIN travado os atalhos não trocam de aba");
    await tecla(p, "n");
    igual(await p.avaliar(() => document.querySelector("#folhaGasto").hidden), true, "com o PIN travado o N não abre a folha");
  },
  "Barra lateral aguenta nome comprido e 700–900 px usa a barra de baixo": async (p) => {
    // 12 caixinhas, uma com nome de 30 letras
    await p.avaliar(() => {
      const cores = ["#9C9BF5", "#E3C98A", "#C9A6F5", "#8FD3B4", "#F2A48A", "#8FB8F5"];
      const caixinhas = Array.from({ length: 12 }, (_, i) => ({ id: "c" + i, nome: i === 2 ? "Supermercado, padaria e feiras" : "Caixinha " + (i + 1), cor: cores[i % cores.length] }));
      localStorage.setItem("caixinhas-orologia-v1", JSON.stringify({ onboarded: true, guiaVisto: true, caixinhas, limitesPadrao: Object.fromEntries(caixinhas.map((c) => [c.id, 100])) }));
    });
    for (const [w, h] of [[900, 480], [1280, 800]]) {
      await p.tamanho(w, h); await p.recarregar();
      // fonte mais larga (como a do Linux): nenhum texto da barra lateral pode estourar
      await p.avaliar(() => { const s = document.createElement("style"); s.textContent = "#lado{letter-spacing:.08em}"; document.head.append(s); });
      const m = await p.avaliar(() => {
        const lado = document.querySelector("#lado"), r = lado.getBoundingClientRect();
        const estoura = [...lado.querySelectorAll("a, button, .n-lado-marca")].filter((e) => e.scrollWidth > e.clientWidth + 1).map((e) => e.textContent.trim());
        const aj = lado.querySelector('a[data-tab="ajustes"]').getBoundingClientRect();
        const rola = lado.scrollHeight > lado.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(lado).overflowY);
        const blocos = [...document.querySelectorAll("#inCx .n-bloco[data-cx]")].filter((b) => b.scrollWidth > b.clientWidth + 1).map((b) => b.dataset.cx);
        return { estoura: estoura.join(" | "), ajAlcanca: aj.bottom <= innerHeight + 0.5 || rola, sobra: document.documentElement.scrollWidth - innerWidth, blocos: blocos.join(","), cont: document.querySelector("#v-inicio").getBoundingClientRect().left, ladoDir: r.right };
      });
      igual(m.estoura, "", `texto estourando na barra lateral em ${w}px`);
      certo(m.ajAlcanca, `em ${w}x${h} o Ajustes da barra lateral fica fora de alcance`);
      certo(m.sobra <= 0, `o Início passa ${m.sobra}px da largura em ${w}px`);
      igual(m.blocos, "", `blocos estourando em ${w}px`);
      certo(m.cont >= m.ladoDir, `em ${w}px o conteúdo entra embaixo da barra lateral`);
      certo((await p.texto('#inCx .n-bloco[data-cx="c2"]')).includes("Supermercado"), "o nome comprido aparece no bloco");
      await p.print(`21-lado-nome-comprido-${w}`);
    }
    // entre 700 e 900 px e celular deitado: barra de baixo, sem barra lateral
    for (const [w, h] of [[899, 700], [768, 1024], [844, 390]]) {
      await p.tamanho(w, h); await p.recarregar();
      certo(!(await p.visivel("#lado")), `em ${w}x${h} a barra lateral não devia aparecer`);
      certo(await p.visivel(".tabs"), `em ${w}x${h} a barra de baixo devia aparecer`);
      const sobra = await p.avaliar(() => document.documentElement.scrollWidth - innerWidth);
      certo(sobra <= 0, `o Início passa ${sobra}px da largura em ${w}x${h}`);
    }
  },
  "Primeira abertura: atalhos de teclado não tiram do passo a passo": async (p) => {
    await p.tamanho(1280, 800); await p.recarregar();
    certo(await p.visivel("#inOnb .onb"), "o passo a passo devia aparecer");
    await p.avaliar(() => document.activeElement && document.activeElement.blur());
    for (const k of ["2", "5", "/"]) await tecla(p, k);
    igual(await p.abaAtual(), "inicio", "com o passo a passo na tela, os números e a / não trocam de aba");
    await tecla(p, "n");
    igual(await p.avaliar(() => document.querySelector("#folhaGasto").hidden), true, "com o passo a passo na tela, o N não abre a folha (as caixinhas ainda não foram escolhidas)");
    certo(await p.visivel("#inOnb .onb"), "o passo a passo continua");
    // os botões de sempre continuam: quem toca no + lança como antes
    await p.clicar("#ladoLancar");
    certo(await p.visivel("#folhaGasto"), "o + Lançar continua abrindo a folha");
    await p.clicar('.folha-topo [data-act="folha-fechar"]');
    await p.clicar('[data-act="onb-skip"]');
    await tecla(p, "2");
    igual(await p.abaAtual(), "mes", "depois do passo a passo os atalhos voltam");
  },
  "Celular deitado: a barra não cobre o arco nem o conteúdo": async (p) => {
    await comExemplo(p);
    const cruza = (a, b) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1;
    for (const [w, h] of [[844, 390], [640, 360]]) {
      await p.tamanho(w, h); await p.recarregar();
      const m = await p.avaliar(() => {
        const r = (q) => { const b = document.querySelector(q).getBoundingClientRect(); return { left: b.left, right: b.right, top: b.top, bottom: b.bottom }; };
        const itens = [...document.querySelectorAll(".tabs nav > *")].map((e) => e.getBoundingClientRect()).map((b) => ({ top: b.top, bottom: b.bottom }));
        return { barra: r(".tabs"), chips: r("#inResumo .n-chips"), arco: r("#arco"), wrap: document.querySelector(".wrap").getBoundingClientRect().right - parseFloat(getComputedStyle(document.querySelector(".wrap")).paddingRight), itens, alto: innerHeight };
      });
      certo(!cruza(m.barra, m.chips) && !cruza(m.barra, m.arco), `em ${w}x${h} a barra cobre o arco ou as etiquetas: ` + JSON.stringify(m));
      certo(m.wrap <= m.barra.left + 0.5 || m.wrap <= 0 || m.barra.top >= m.chips.bottom, `em ${w}x${h} o conteúdo passa por baixo da barra: ` + JSON.stringify(m));
      certo(m.itens.every((i) => i.top >= 0 && i.bottom <= m.alto), `em ${w}x${h} algum botão da barra sai da tela: ` + JSON.stringify(m.itens));
      // as abas continuam funcionando
      await p.clicar('.tabs a[data-tab="mes"]');
      igual(await p.abaAtual(), "mes", "a barra leva ao Mês no celular deitado");
      await p.aba("inicio");
      await p.print(`21-celular-deitado-${w}`);
    }
  },
  "Aviso no celular deitado não passa por baixo do trilho": async (p) => {
    await comExemplo(p);
    for (const [w, h] of [[640, 360], [844, 390]]) {
      await p.tamanho(w, h); await p.recarregar(); await p.aba("ajustes/aparencia");
      // um aviso bem comprido: o erro de um arquivo com outro formato repete o nome do formato
      await p.clicar('[data-tm="colar"]');
      await p.digitar("#temaCola", JSON.stringify({ formato: "um-formato-de-tema-com-um-nome-muito-comprido-que-nao-acaba-mais-nunca", nome: "x" }));
      await p.clicar('[data-tm="importar"]');
      const m = await p.avaliar(() => { const r = (q) => { const b = document.querySelector(q).getBoundingClientRect(); return { left: b.left, right: b.right, top: b.top, bottom: b.bottom }; }; return { aviso: r("#toast"), trilho: r(".tabs"), largura: innerWidth }; });
      certo(m.aviso.right - m.aviso.left > 300, `o aviso devia ser comprido em ${w}x${h}: ` + JSON.stringify(m.aviso));
      certo(m.aviso.left >= 0 && m.aviso.right <= m.trilho.left - 4, `em ${w}x${h} o aviso passa por baixo do trilho ou sai da tela: ` + JSON.stringify(m));
      await p.print(`21-aviso-deitado-${w}`);
    }
  },
  "Calculadoras em pé no PC: setas para cima e para baixo": async (p) => {
    await comExemplo(p);
    const estado = () => p.avaliar(() => ({ ori: document.querySelector(".calc-tabs").getAttribute("aria-orientation"), sel: document.querySelector('.calc-tabs [aria-selected="true"]').dataset.calc, foco: document.activeElement.dataset.calc, vis: !document.querySelector("#c-" + document.querySelector('.calc-tabs [aria-selected="true"]').dataset.calc).hidden }));
    const focar = () => p.avaliar(() => document.querySelector('.calc-tabs [aria-selected="true"]').focus());
    await p.tamanho(1280, 800); await p.recarregar(); await p.aba("calc"); await focar();
    igual((await estado()).ori, "vertical", "no PC a lista das calculadoras está em pé");
    await tecla(p, "ArrowDown"); await p.espera(80);
    igual(JSON.stringify(await estado()), JSON.stringify({ ori: "vertical", sel: "not", foco: "not", vis: true }), "seta para baixo vai à próxima calculadora");
    await tecla(p, "ArrowUp"); await p.espera(80);
    igual((await estado()).sel + (await estado()).foco, "liqliq", "seta para cima volta");
    await tecla(p, "End"); await p.espera(80);
    igual((await estado()).sel, "pmt", "End vai à última");
    await p.tamanho(360, 780); await p.recarregar(); await p.aba("calc"); await focar();
    igual((await estado()).ori, "horizontal", "no celular a lista das calculadoras está deitada");
    await tecla(p, "ArrowRight"); await p.espera(80);
    igual((await estado()).sel + (await estado()).foco, "notnot", "no celular a seta para a direita vai à próxima");
    await tecla(p, "ArrowLeft"); await p.espera(80);
    igual((await estado()).sel, "liq", "e para a esquerda volta");
  },
  "Mês: tocar no lançamento abre a edição, e apagar fica dentro dela": async (p) => {
    await comExemplo(p); await p.aba("mes");
    const linhas = await p.avaliar(() => [...document.querySelectorAll("#mesLista .n-lanc[data-id]")].map((b) => ({ tag: b.tagName, act: b.dataset.act, ex: !!b.querySelector(".ex"), foco: b.tabIndex })));
    certo(linhas.length === 5, "cinco lançamentos na lista do exemplo: " + linhas.length);
    certo(linhas.every((l) => l.tag === "BUTTON" && l.act === "ed-gasto" && l.foco >= 0), "cada linha é um botão que abre a edição: " + JSON.stringify(linhas[0]));
    certo(linhas.every((l) => l.ex), "a etiqueta 'exemplo' continua na linha");
    // cada linha mostra que é tocável: uma seta discreta à direita, escondida do leitor de tela (o rótulo já diz "Editar")
    const setas = await p.avaliar(() => [...document.querySelectorAll("#mesLista .n-lanc")].map((b) => { const s = b.querySelector(".n-seta"); if (!s) return "sem"; const r = s.getBoundingClientRect(), v = b.querySelector(".val").getBoundingClientRect(); return s.getAttribute("aria-hidden") === "true" && r.width > 0 && r.left >= v.right - 1 ? "ok" : "ruim"; }));
    igual(setas.join(","), "ok,ok,ok,ok,ok", "seta de tocar à direita de cada linha");
    igual(await p.avaliar(() => document.querySelectorAll('#mesLista [data-act="del-gasto"], #mesLista .act').length), 0, "a lista não tem mais os links Editar e Apagar");
    const id = await p.avaliar(() => [...document.querySelectorAll("#mesLista .n-lanc")].find((b) => b.textContent.includes("Uber")).dataset.id);
    const rotulo = await p.avaliar((id) => document.querySelector('.n-lanc[data-id="' + id + '"]').getAttribute("aria-label").replace(/\s+/g, " "), id);
    certo(/^Editar Uber/.test(rotulo) && rotulo.includes("R$ 18,50") && rotulo.includes("exemplo"), "o leitor de tela ouve o que a linha faz: " + rotulo);
    // a folha nova não tem o botão de apagar
    await p.clicar("#fab");
    igual(await p.visivel("#gApagar"), false, "lançar um gasto novo não mostra Apagar");
    await p.clicar('.folha-topo [data-act="folha-fechar"]');
    // tocar na linha abre a edição com Apagar; o primeiro toque arma, o segundo apaga (a mesma confirmação da 1.9)
    await p.clicar('.n-lanc[data-id="' + id + '"]');
    certo(await p.visivel("#folhaGasto"), "tocar na linha devia abrir a folha");
    igual(await p.texto("#gHead"), "Editar gasto", "a folha abre em edição");
    igual(await p.avaliar(() => document.querySelector("#gValor").value), "18,5", "com o valor do gasto");
    certo(await p.visivel("#gApagar"), "a edição tem o botão Apagar");
    igual(await p.texto("#gApagar"), "Apagar gasto", "texto do botão");
    await p.clicar("#gApagar");
    igual(await p.texto("#gApagar"), "Toque de novo para apagar", "o primeiro toque só arma");
    certo(await p.visivel("#folhaGasto"), "a folha continua aberta depois do primeiro toque");
    const existe = () => p.avaliar((id) => Object.values(JSON.parse(localStorage.getItem("caixinhas-orologia-v1")).meses).some((m) => (m.gastos || []).some((g) => g.id === id)), id);
    igual(await existe(), true, "o gasto ainda existe depois do primeiro toque");
    await p.clicar("#gApagar"); await p.espera(150);
    igual(await existe(), false, "o segundo toque apaga");
    igual(await p.visivel("#folhaGasto"), false, "a folha fecha depois de apagar");
    igual(await p.texto("#toast"), "Gasto apagado", "aviso");
    igual(await p.abaAtual(), "mes", "continua no Mês");
    // a confirmação desarma sozinha, como na 1.9
    await p.clicar("#mesLista .n-lanc");
    await p.clicar("#gApagar"); await p.espera(3700);
    igual(await p.texto("#gApagar"), "Apagar gasto", "a confirmação desarma depois de uns segundos");
    await p.clicar('.folha-topo [data-act="folha-fechar"]');
  },
  "Armar o Apagar na folha de edição não mexe nos campos do gasto": async (p) => {
    // gasto com uma forma que saiu da lista de formas (o select da folha ganha uma opção só para ela)
    const semear = () => p.avaliar(() => {
      const d = new Date(), k = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
      localStorage.setItem("caixinhas-orologia-v1", JSON.stringify({ onboarded: true, guiaVisto: true, formas: ["Pix", "Débito", "Crédito"],
        caixinhas: [{ id: "a", nome: "Casa", cor: "#9C9BF5" }, { id: "b", nome: "Lazer", cor: "#E3C98A" }], limitesPadrao: { a: 500, b: 300 },
        meses: { [k]: { gastos: [{ id: "g1", valor: 42, descricao: "Feira", caixinha: "b", forma: "Cheque", data: k + "-02" }] } } }));
      return k;
    });
    const gravado = () => p.avaliar(() => { const m = Object.values(JSON.parse(localStorage.getItem("caixinhas-orologia-v1")).meses)[0]; const g = m.gastos.find((x) => x.id === "g1"); return [g.forma, g.caixinha, g.valor, g.descricao, g.data].join("|"); });
    for (const esperar of [false, true]) {
      const k = await semear(); await p.recarregar(); await p.aba("mes");
      await p.clicar('#mesLista .n-lanc[data-id="g1"]');
      igual(await p.avaliar(() => document.querySelector("#gForma").value), "Cheque", "a folha abre com a forma do gasto");
      await p.clicar("#gApagar");
      igual(await p.texto("#gApagar"), "Toque de novo para apagar", "Apagar armado");
      if (esperar) { await p.espera(3700); igual(await p.texto("#gApagar"), "Apagar gasto", "desarmou sozinho"); }
      const tela = await p.avaliar(() => ["#gForma", "#gValor", "#gDesc", "#gData"].map((q) => document.querySelector(q).value).concat([(document.querySelector('input[name="gCx"]:checked') || {}).value]).join("|"));
      igual(tela, "Cheque|42|Feira|" + k + "-02|b", "os campos da folha depois de armar" + (esperar ? " e desarmar" : ""));
      await p.clicar("#gBtn"); await p.espera(150);
      igual(await gravado(), "Cheque|b|42|Feira|" + k + "-02", "o gasto salvo depois de desistir de apagar" + (esperar ? " (com o desarme automático)" : ""));
    }
  },
  "Editar gasto de caixinha apagada não o move sem a pessoa ver": async (p) => {
    // g1 é de uma caixinha que foi apagada ("z"); antes de editar, a folha estava com o Lazer marcado
    const k = await p.avaliar(() => {
      const d = new Date(), k = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
      localStorage.setItem("caixinhas-orologia-v1", JSON.stringify({ onboarded: true, guiaVisto: true, formas: ["Pix", "Débito", "Crédito"],
        caixinhas: [{ id: "a", nome: "Casa", cor: "#9C9BF5" }, { id: "b", nome: "Lazer", cor: "#E3C98A" }], limitesPadrao: { a: 500, b: 300 },
        meses: { [k]: { gastos: [{ id: "g1", valor: 42, descricao: "Antigo", caixinha: "z", forma: "Pix", data: k + "-02" }] } } }));
      return k;
    });
    await p.recarregar(); await p.aba("mes");
    await p.clicar("#fab"); await p.clicar('input[name="gCx"][value="b"]'); await p.clicar('.folha-topo [data-act="folha-fechar"]');
    const marcada = () => p.avaliar(() => [...document.querySelectorAll('input[name="gCx"]:checked')].map((r) => r.value + ":" + document.querySelector('label[for="' + r.id + '"]').textContent.trim()).join(","));
    const gravado = () => p.avaliar(() => { const m = Object.values(JSON.parse(localStorage.getItem("caixinhas-orologia-v1")).meses)[0]; const g = m.gastos.find((x) => x.id === "g1"); return [g.caixinha, g.valor, g.descricao].join("|"); });
    await p.clicar('#mesLista .n-lanc[data-id="g1"]');
    const m1 = await marcada();
    certo(/^z:.*apagada/i.test(m1), "a folha devia mostrar que a caixinha do gasto foi apagada: " + m1);
    certo(/apagada/i.test(await p.texto("#gPrev")), "o aviso da folha devia dizer que a caixinha foi apagada: " + await p.texto("#gPrev"));
    // armar e desarmar o Apagar (redesenho do Mês) não troca a caixinha
    await p.clicar("#gApagar"); await p.espera(3700);
    igual((await marcada()).split(":")[0], "z", "a caixinha apagada continua marcada depois do redesenho");
    await p.clicar("#gBtn"); await p.espera(150);
    igual(await gravado(), "z|42|Antigo", "salvar sem mexer na caixinha mantém o gasto como está");
    // escolher outra caixinha continua movendo o gasto
    await p.clicar('#mesLista .n-lanc[data-id="g1"]');
    await p.clicar('input[name="gCx"][value="a"]');
    await p.clicar("#gBtn"); await p.espera(150);
    igual(await gravado(), "a|42|Antigo", "escolher a Casa move o gasto");
    igual(k.length, 7, "mês");
  },
  "Sair da edição sem salvar não deixa forma nem caixinha antigas na folha": async (p) => {
    await p.avaliar(() => {
      const d = new Date(), k = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
      localStorage.setItem("caixinhas-orologia-v1", JSON.stringify({ onboarded: true, guiaVisto: true, formas: ["Pix", "Débito", "Crédito"],
        caixinhas: [{ id: "a", nome: "Casa", cor: "#9C9BF5" }, { id: "b", nome: "Lazer", cor: "#E3C98A" }], limitesPadrao: { a: 500, b: 300 },
        meses: { [k]: { gastos: [{ id: "g1", valor: 42, descricao: "Feira", caixinha: "z", forma: "Cheque", data: k + "-02" }] } } }));
    });
    await p.recarregar(); await p.aba("mes");
    const folha = () => p.avaliar(() => ({ forma: document.querySelector("#gForma").value, formas: [...document.querySelector("#gForma").options].map((o) => o.value).join(","),
      cx: (document.querySelector('input[name="gCx"]:checked') || {}).value, cxs: [...document.querySelectorAll('input[name="gCx"]')].map((r) => r.value).join(",") }));
    const jeitos = { "no X": () => p.clicar('.folha-topo [data-act="folha-fechar"]'), "com Esc": () => tecla(p, "Escape"), "pelo Voltar": () => p.avaliar(() => history.back()) };
    for (const [jeito, fechar] of Object.entries(jeitos)) {
      await p.clicar('#mesLista .n-lanc[data-id="g1"]');
      const f0 = await folha();
      igual(f0.forma + "|" + f0.cx, "Cheque|z", "a edição abre com a forma e a caixinha do gasto");
      await fechar(); await p.espera(250);
      igual(await p.visivel("#folhaGasto"), false, "a folha fechou " + jeito);
      await p.clicar("#fab");
      const f = await folha();
      igual(f.formas, "Pix,Débito,Crédito", "fechando " + jeito + ", o próximo lançamento só oferece as formas da lista");
      igual(f.cxs, "a,b", "fechando " + jeito + ", o próximo lançamento só oferece as caixinhas que existem");
      certo(f.forma !== "Cheque" && ["a", "b"].includes(f.cx), "fechando " + jeito + ", o próximo lançamento não sai com a forma ou a caixinha antigas: " + JSON.stringify(f));
      await p.clicar('.folha-topo [data-act="folha-fechar"]');
    }
  },
  "Metas não fala em investimentos no título": async (p) => {
    await comExemplo(p); await p.aba("metas");
    igual(await p.texto("#v-metas h2"), "Metas", "título da tela");
    certo(!/investiment/i.test(await p.texto("#v-metas .vhead")), "o cabeçalho de Metas não fala em investimentos: " + await p.texto("#v-metas .vhead"));
    certo(!/investiment/i.test(await p.avaliar(() => [...document.querySelectorAll("#v-guia summary")].map((s) => s.textContent).join(" | "))), "o guia não chama a seção de investimentos");
  },
  "Troca de aba e folha têm passagem, e param com reduzir movimento": { movimento: true, fn: async (p) => {
    await comExemplo(p); await p.espera(2300);
    const naTela = (q) => p.avaliar((q) => document.querySelector(q).getAnimations().map((a) => Math.round(a.effect.getComputedTiming().endTime)), q);
    // toca na aba e lê as animações no mesmo instante (a passagem dura menos que a espera do p.aba)
    const irPara = (aba) => p.avaliar((aba) => { document.querySelector('.tabs a[data-tab="' + aba + '"]').click(); return document.querySelector("#v-" + aba).getAnimations().map((a) => Math.round(a.effect.getComputedTiming().endTime)); }, aba);
    const passagem = await irPara("mes");
    certo(passagem.length > 0, "trocar de aba devia ter uma passagem curta");
    certo(passagem.every((ms) => ms <= 180), "a passagem entre abas passa de 180 ms: " + passagem.join(","));
    await p.espera(250);
    igual((await naTela("#v-mes")).length, 0, "a passagem termina sozinha");
    await p.clicar("#fab"); await p.espera(20);
    certo((await naTela(".folha-caixa")).length > 0, "a folha devia subir com movimento");
    await p.espera(600);
    igual(await animando(p), 0, "nada fica animando depois da folha abrir");
    await p.clicar('.folha-topo [data-act="folha-fechar"]');
    // números do resumo contam ao entrar na tela, e terminam no valor real
    await p.aba("cartao"); await p.espera(40);
    const contando = await p.texto("#cartResumo .big");
    await p.espera(900);
    igual(await p.texto("#cartResumo .big"), "R$ 111,40", "o total da fatura termina no valor real");
    certo(contando !== "R$ 111,40", "o total da fatura devia contar ao entrar: " + contando);
    // uma ação nova interrompe a contagem: o valor na tela é o real na hora
    await p.aba("metas"); await p.espera(40);
    await aportar(p, "Viagem", 100); await p.espera(30);
    igual(await p.texto("#metasResumo .big"), "R$ 3.000,00", "aportar no meio da contagem mostra o valor real");
    // com "reduzir movimento", nada disso se move
    await p.reduzir(true);
    igual((await irPara("mes")).length, 0, "com reduzir movimento, a troca de aba não se move");
    await p.aba("cartao"); await p.espera(20);
    igual(await p.texto("#cartResumo .big"), "R$ 111,40", "com reduzir movimento o número já vem pronto");
    await p.clicar("#fab"); await p.espera(20);
    igual(await animando(p), 0, "com reduzir movimento, a folha não se move");
  } },
  "Tema com brilho: importa, aplica e exporta": async (p) => {
    await comExemplo(p);
    const tema = { formato: "orologia-tema", versao: 1, nome: "Brilho de teste", fundo: "#101820", card: "#18242E", texto: "#EEF4F8", suave: "#9FB2C0", destaque: "#6FB7FF", secundaria: "#F2C879", brilho: "#e0457b", raio: 16, fonte: "padrao" };
    await colarTema(p, tema);
    igual(await varCss(p, "--bg"), "#101820", "o tema importado vale na hora");
    igual(await varCss(p, "--glow"), "#E0457B", "o clarão do fundo usa o brilho do tema");
    const guardado = (await lerTemaGuardado(p)).meus.find((t) => t.nome === "Brilho de teste");
    igual(guardado && guardado.brilho, "#E0457B", "o brilho fica guardado com o tema");
    const ex = await temaExportado(p);
    igual(ex.brilho, "#E0457B", "a exportação leva o brilho");
    igual(ex.formato + "|" + ex.versao + "|" + ex.destaque, "orologia-tema|1|#6FB7FF", "o formato continua o mesmo (versão 1)");
    await p.recarregar();
    igual(await varCss(p, "--glow"), "#E0457B", "o brilho continua depois de abrir de novo");
    // #RGB também vale para o brilho; brilho inválido recusa o tema com um aviso que diz o campo
    await colarTema(p, Object.assign({}, tema, { nome: "Curto", brilho: "#f0a" }));
    igual(await varCss(p, "--glow"), "#FF00AA", "brilho em #RGB é convertido");
    const antes = (await lerTemaGuardado(p)).meus.length;
    await colarTema(p, Object.assign({}, tema, { nome: "Ruim", brilho: "rosa" }));
    certo(/brilho/i.test(await p.texto("#toast")), "o aviso devia falar do brilho: " + await p.texto("#toast"));
    igual((await lerTemaGuardado(p)).meus.length, antes, "tema com brilho inválido não entra");
    // um tema criado na Aparência também leva o brilho escolhido
    await p.clicar('[data-tm="criar"]');
    await p.digitar("#tm-brilho", "#33cc99");
    igual(await varCss(p, "--glow"), "#33CC99", "mexer no brilho do tema em edição muda o clarão na hora");
    await p.clicar('[data-tm="salvar"]');
    igual((await temaExportado(p)).brilho, "#33CC99", "o tema salvo exporta o brilho escolhido");
  },
  "Tema sem brilho continua valendo": async (p) => {
    await comExemplo(p);
    // o exemplo do README de antes da 2.0 (sem brilho), como o Orolon Player exporta
    const antigo = `{
  "formato": "orologia-tema",
  "versao": 1,
  "nome": "Orologia Noite",
  "fundo": "#110E18",
  "card": "#1C1827",
  "texto": "#EEEAF5",
  "suave": "#A49EB8",
  "destaque": "#9C9BF5",
  "secundaria": "#E3C98A",
  "raio": 14,
  "fonte": "padrao"
}`;
    await colarTema(p, antigo);
    igual(await p.texto("#toast"), 'Tema "Orologia Noite" importado', "o tema antigo entra");
    igual(await varCss(p, "--bg"), "#110E18", "e vale na hora");
    igual(await varCss(p, "--glow"), misturar("#9C9BF5", "#110E18", 0.35), "sem brilho, o clarão vem do destaque");
    const guardado = (await lerTemaGuardado(p)).meus.find((t) => t.nome === "Orologia Noite");
    igual("brilho" in guardado, false, "o tema guardado continua sem brilho (segue o destaque)");
    // editar o destaque de um tema sem brilho muda o clarão junto
    await p.clicar('[data-tm="editar"][data-id="' + guardado.id + '"]');
    await p.digitar("#tm-destaque", "#ff8800");
    igual(await varCss(p, "--glow"), misturar("#FF8800", "#110E18", 0.35), "sem brilho, mudar o destaque muda o clarão");
    await p.clicar('[data-tm="cancelar"]');
    const ex = await temaExportado(p);
    igual(ex.brilho, misturar("#9C9BF5", "#110E18", 0.35), "a exportação leva o brilho que está na tela");
    for (const k of ["formato", "versao", "nome", "fundo", "card", "texto", "suave", "destaque", "secundaria", "raio", "fonte"]) igual(ex[k], JSON.parse(antigo)[k], "campo " + k + " exportado igual");
    // um tema próprio da 1.9 (sem brilho) guardado no aparelho abre igual
    await p.avaliar(() => localStorage.setItem("caixinhas-orologia-tema", JSON.stringify({ atual: "tmeu1", meus: [{ id: "tmeu1", nome: "Meu roxo", fundo: "#1A1030", card: "#2A1F45", texto: "#F5F0FF", suave: "#B8A8D8", destaque: "#C78BFF", secundaria: "#FFD27A", raio: 16, fonte: "padrao" }] })));
    await p.recarregar();
    igual(await varCss(p, "--bg"), "#1A1030", "tema próprio da 1.9 continua aplicado");
    igual(await varCss(p, "--glow"), misturar("#C78BFF", "#1A1030", 0.35), "com o clarão do destaque");
  },
  "Todos os temas de fábrica passam no contraste": async (p) => {
    await comExemplo(p); await p.aba("ajustes/aparencia");
    const ids = await p.avaliar(() => [...document.querySelectorAll('#temaBox [data-tm="usar"]')].map((b) => b.dataset.id));
    for (const v of ["noite", "dia", "g-brasa", "g-entardecer", "g-folha", "g-mare", "g-meia-noite", "g-papel"]) certo(ids.includes(v), "o tema de antes continua: " + v);
    const novos = ids.filter((i) => !["noite", "dia", "g-brasa", "g-entardecer", "g-folha", "g-mare", "g-meia-noite", "g-papel"].includes(i));
    certo(novos.length >= 5 && novos.length <= 6, "de 5 a 6 temas novos: " + novos.join(","));
    certo(novos.every((i) => /^g-[a-z-]+$/.test(i)), "temas novos com id g-…: " + novos.join(","));
    const claros = await p.avaliar((ns) => ns.filter((i) => { const t = window.TemaCx.porId(i); return window.TemaCx.contraste(t.fundo, "#FFFFFF") < 2; }).length, novos);
    certo(claros >= 2 && novos.length - claros >= 2, "temas novos claros e escuros: " + claros + " claros de " + novos.length);
    for (const id of ids) {
      await p.clicar('#temaBox [data-tm="usar"][data-id="' + id + '"]');
      // a mesma tabela de contraste que a pessoa vê ao criar um tema a partir do ativo
      await p.clicar('[data-tm="criar"]');
      const linhas = await p.avaliar(() => [...document.querySelectorAll("#tmCtr .ctr")].map((l) => l.textContent.replace(/\s+/g, " ").trim()));
      igual(linhas.length, 5, "linhas de contraste");
      const fracas = linhas.filter((l) => /fraco/.test(l));
      igual(fracas.join(" | "), "", "contraste do tema " + id);
      await p.clicar('[data-tm="cancelar"]');
      // além da tabela: etiquetas ok/passou e o + legíveis
      const extra = await p.avaliar(() => {
        const v = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), C = window.TemaCx.contraste;
        return { ok: C(v("--ok"), v("--bg")), over: C(v("--over"), v("--bg")), tinta: Math.min(C(v("--accent-ink"), v("--accent")), C(v("--accent-ink"), v("--fab-fim"))) };
      });
      certo(extra.ok >= 3 && extra.over >= 3, `etiquetas ok/passou legíveis no tema ${id}: ` + JSON.stringify(extra));
      certo(extra.tinta >= 3, `o + legível nas duas pontas do degradê no tema ${id}: ` + JSON.stringify(extra));
    }
  },
  "Tema fora do padrão não some com os cartões": async (p) => {
    await comExemplo(p);
    const base = { raio: 16, fonte: "padrao" };
    const casos = {
      "tema claro": { id: "tc1", nome: "Claro", fundo: "#FAFAF7", card: "#FFFFFF", texto: "#222222", suave: "#5C5C5C", destaque: "#2F6FD6", secundaria: "#9A4B2F" },
      "card igual ao fundo (escuro)": { id: "tc2", nome: "Chapado", fundo: "#14141A", card: "#14141A", texto: "#EDEDF2", suave: "#A0A0AE", destaque: "#8FA0FF", secundaria: "#E3C98A" },
      "card igual ao fundo (claro)": { id: "tc3", nome: "Chapado claro", fundo: "#F4F4F4", card: "#F4F4F4", texto: "#1A1A1A", suave: "#575757", destaque: "#3355CC", secundaria: "#8C5E14" },
      "tema próprio sem brilho": { id: "tc4", nome: "Sem brilho", fundo: "#0F1A12", card: "#1A2A1E", texto: "#EAF5EC", suave: "#9DB8A2", destaque: "#7FD98F", secundaria: "#F0C674" },
    };
    for (const [caso, t] of Object.entries(casos)) {
      await p.avaliar((t) => localStorage.setItem("caixinhas-orologia-tema", JSON.stringify({ atual: t.id, meus: [t] })), Object.assign({}, base, t));
      await p.recarregar();
      igual(await varCss(p, "--bg"), t.fundo, "tema aplicado (" + caso + ")");
      for (const sel of ["#inRitmo", "#inCx .n-bloco[data-cx]", ".tabs"]) {
        const c = await coresSobreFundo(p, sel);
        certo(c.cBorda >= 1.15, `${caso}: a borda de ${sel} some no fundo (${c.cBorda.toFixed(2)}): ` + JSON.stringify(c));
        certo(c.cTexto >= 4.5, `${caso}: o texto de ${sel} fica ilegível (${c.cTexto.toFixed(2)}): ` + JSON.stringify(c));
      }
      await p.aba("mes");
      for (const sel of ["#v-mes .n-lancs", "#v-mes details", "#mesBoxes .box"]) {
        const c = await coresSobreFundo(p, sel);
        certo(c.cBorda >= 1.15 && c.cTexto >= 4.5, `${caso}: cartão do Mês (${sel}) ` + JSON.stringify(c));
      }
      await p.aba("inicio");
    }
  },
  "Galeria mostra miniaturas e trocar de tema vale na hora": async (p) => {
    await comExemplo(p); await p.aba("ajustes/aparencia");
    const minis = await p.avaliar(() => [...document.querySelectorAll('#temaBox .tema-card [data-tm="usar"]')].map((b) => {
      const t = window.TemaCx.porId(b.dataset.id), m = b.querySelector("svg.n-mini");
      if (!m) return b.dataset.id + ": sem miniatura";
      const cor = (q, a) => { const e = m.querySelector(q); return e ? (e.getAttribute(a) || "").toUpperCase() : "falta " + q; };
      const erros = [];
      if (cor(".n-mini-fundo", "fill") !== t.fundo) erros.push("fundo " + cor(".n-mini-fundo", "fill"));
      if (cor(".n-mini-arco", "stroke") !== t.destaque) erros.push("arco " + cor(".n-mini-arco", "stroke"));
      if (!m.querySelector(".n-mini-bloco")) erros.push("sem bloco");
      if (cor(".n-mini-barra", "fill") !== t.card) erros.push("barra " + cor(".n-mini-barra", "fill"));
      if (!m.querySelector(".n-mini-mais")) erros.push("sem o +");
      if (m.getAttribute("aria-hidden") !== "true") erros.push("a miniatura devia ficar fora do leitor de tela");
      const r = m.getBoundingClientRect();
      if (r.width < 90 || r.height < 50) erros.push("pequena demais " + r.width + "x" + r.height);
      return erros.length ? b.dataset.id + ": " + erros.join(", ") : "";
    }).filter(Boolean));
    igual(minis.join(" | "), "", "cada tema mostra uma miniatura do Início com as cores dele");
    const n = await p.avaliar(() => document.querySelectorAll('#temaBox [data-tm="usar"]').length);
    certo(n >= 13, "temas de fábrica na Aparência: " + n);
    certo(!/apoiador|premium|pago|comprar|desbloque/i.test(await p.texto("#v-ajustes")), "nada de tema pago ou Apoiador na Aparência");
    // trocar de tema vale na hora, sem recarregar
    const alvo = await p.avaliar(() => [...document.querySelectorAll('#temaBox [data-tm="usar"]')].map((b) => b.dataset.id).filter((i) => !["noite", "dia", "g-brasa", "g-entardecer", "g-folha", "g-mare", "g-meia-noite", "g-papel"].includes(i))[0]);
    const fundo = await p.avaliar((i) => window.TemaCx.porId(i).fundo, alvo);
    await p.clicar('#temaBox [data-tm="usar"][data-id="' + alvo + '"]');
    igual(await varCss(p, "--bg"), fundo, "o tema novo vale na hora");
    igual(await p.avaliar((i) => document.querySelector('#temaBox [data-tm="usar"][data-id="' + i + '"]').getAttribute("aria-pressed") + "|" + document.querySelectorAll('#temaBox [aria-pressed="true"]').length, alvo), "true|1", "só o tema escolhido fica marcado");
    igual(await p.avaliar(() => document.querySelector('meta[name="theme-color"]').getAttribute("content").toUpperCase()), fundo, "a cor da barra do navegador acompanha");
    await p.recarregar();
    igual(await varCss(p, "--bg"), fundo, "o tema escolhido fica salvo");
    igual((await lerTemaGuardado(p)).atual, alvo, "guardado na chave do tema");
  },
  "Visual leve: a chave liga e desliga; o automático grava e não religa depois de desligado à mão": { movimento: true, fn: async (p) => {
    // os avisos (toast) que aparecem a cada carregamento ficam anotados em window.__avisos
    await p.injetar(`window.__avisos = []; document.addEventListener("DOMContentLoaded", () => { const t = document.getElementById("toast"); new MutationObserver(() => { if (!t.hidden) window.__avisos.push(t.textContent); }).observe(t, { attributes: true, childList: true, characterData: true, subtree: true }); });`);
    const leve = () => p.avaliar(() => document.documentElement.hasAttribute("data-leve"));
    const guardado = async () => (await lerTemaGuardado(p)).leve;
    const avisosLeve = () => p.avaliar(() => window.__avisos.filter((a) => /visual leve/i.test(a)).length);
    const chave = async () => { await p.aba("ajustes/aparencia"); const r = await p.avaliar(() => ({ marcada: document.querySelector("#tgLeve").checked, nota: (document.querySelector("#tgLeveNota") || {}).textContent || "", notaVisivel: !!document.querySelector("#tgLeveNota") && !document.querySelector("#tgLeveNota").hidden })); await p.aba("inicio"); return r; };
    // 1) Prova: sem o gancho, o Chrome dos testes abre rápido e o visual leve não liga sozinho
    await p.avaliar(() => localStorage.setItem("caixinhas-orologia-tema", JSON.stringify({ atual: "noite", meus: [] }))); // chave da 1.9, sem "leve"
    await comExemplo(p); await p.recarregar(); await p.espera(2200);
    igual(await p.avaliar(() => document.querySelector("#inResumo").dataset.abertura), "longa", "a abertura longa tocou");
    igual(await leve(), false, "sem quadros lentos o visual leve não liga");
    igual(await guardado(), undefined, "e nada é gravado");
    igual((await chave()).marcada, false, "a chave começa desligada");
    // 2) abertura com quadros lentos: liga sozinho, grava 'auto', avisa uma vez e aparece na chave
    await p.injetar("window.__quadroLento = 45;");
    await p.recarregar(); await p.espera(2200);
    igual(await leve(), true, "quadros lentos na abertura ligam o visual leve");
    igual(await guardado(), "auto", "o ligar sozinho fica gravado");
    igual(await avisosLeve(), 1, "avisa uma vez");
    const c1 = await chave();
    certo(c1.marcada && c1.notaVisivel && /automaticamente/i.test(c1.nota), "a chave mostra que ligou sozinho: " + JSON.stringify(c1));
    // 3) abrir de novo: já abre leve, sem medir nem avisar outra vez
    await p.recarregar();
    igual(await leve(), true, "o visual leve já vem ligado na abertura seguinte");
    await p.espera(2200);
    igual(await avisosLeve(), 0, "não avisa de novo");
    // 4) a pessoa desliga: tira na hora, grava 'nao' e a próxima abertura lenta não religa
    await p.aba("ajustes/aparencia"); await p.clicar("#tgLeve");
    igual(await leve(), false, "desligar a chave tira o visual leve na hora");
    igual(await guardado(), "nao", "desligado à mão fica gravado");
    igual(await p.avaliar(() => document.querySelector("#tgLeveNota").hidden), true, "a nota de automático some");
    await p.aba("inicio"); await p.recarregar(); await p.espera(2200);
    igual(await p.avaliar(() => window.__quadroLento), 45, "a abertura continua lenta");
    igual(await leve(), false, "depois de desligado à mão, não religa sozinho");
    igual(await guardado(), "nao", "continua 'nao'");
    igual(await avisosLeve(), 0, "nem avisa");
    // 5) ligar e desligar à mão
    await p.aba("ajustes/aparencia"); await p.clicar("#tgLeve");
    igual(await leve() + "|" + await guardado(), "true|sim", "ligar à mão");
    await p.clicar("#tgLeve");
    igual(await leve() + "|" + await guardado(), "false|nao", "desligar à mão");
    // o tema escolhido e os temas próprios continuam na mesma chave
    igual((await lerTemaGuardado(p)).atual, "noite", "o tema continua guardado junto");
  } },
  "Visual leve tira clarões e gradientes": async (p) => {
    await comExemplo(p);
    const visual = () => p.avaliar(() => {
      const cs = (q) => getComputedStyle(document.querySelector(q));
      return { corpo: cs("body").backgroundImage, bloco: cs("#inCx .n-bloco[data-cx]").backgroundImage, resumo: cs(".n-resumo") ? cs(".n-resumo").backgroundImage : "none",
        arco: cs("#arco .arco-luz").filter, barra: cs(".tabs").boxShadow, borrao: cs(".tabs").backdropFilter, mais: cs("#fab").boxShadow, vidro: cs("#inRitmo").boxShadow };
    });
    const antes = await visual();
    certo(/gradient/.test(antes.corpo) && /gradient/.test(antes.bloco) && antes.arco !== "none" && antes.barra !== "none", "sem o visual leve há clarões, gradientes e sombras: " + JSON.stringify(antes));
    await p.aba("ajustes/aparencia"); await p.clicar("#tgLeve"); await p.aba("inicio");
    igual(await p.avaliar(() => document.documentElement.hasAttribute("data-leve")), true, "a chave põe data-leve no html");
    const depois = await visual();
    igual(JSON.stringify(depois), JSON.stringify({ corpo: "none", bloco: "none", resumo: "none", arco: "none", barra: "none", borrao: "none", mais: "none", vidro: "none" }), "o visual leve tira clarões, gradientes, sombras e desfoque");
    // a cor da caixinha continua no bloco (sem gradiente, só uma cor chapada)
    const blocoCor = await p.avaliar(() => getComputedStyle(document.querySelector("#inCx .n-bloco[data-cx]")).backgroundColor);
    certo(blocoCor !== "rgba(0, 0, 0, 0)", "o bloco continua com fundo: " + blocoCor);
    await p.print("23-leve-noite-360");
    await p.aba("ajustes/aparencia"); await p.print("23-leve-aparencia-noite-360");
    await p.clicar('#temaBox [data-tm="usar"][data-id="dia"]'); await p.aba("inicio");
    await p.print("23-leve-dia-360");
  },
  "Temas de fábrica legíveis no Início, Mês, Gráficos e folha (prints)": async (p) => {
    await comExemplo(p);
    const ANTIGOS = ["noite", "dia", "g-brasa", "g-entardecer", "g-folha", "g-mare", "g-meia-noite", "g-papel"];
    const ids = await p.avaliar(() => window.TemaCx.todos().filter((t) => t.fixo).map((t) => t.id));
    const largura = async (onde) => { const s = await p.avaliar(() => document.documentElement.scrollWidth - innerWidth); certo(s <= 0, `${onde} passa ${s}px da largura`); };
    for (const id of ids) {
      await p.avaliar((id) => { const o = JSON.parse(localStorage.getItem("caixinhas-orologia-tema") || "{}"); o.atual = id; localStorage.setItem("caixinhas-orologia-tema", JSON.stringify(o)); }, id);
      await p.tamanho(360, 780); await p.recarregar();
      await largura("Início " + id); await p.print(`24-tema-${id}-inicio-360`);
      if (ANTIGOS.includes(id)) continue;
      for (const t of ["mes", "graficos"]) { await p.aba(t); await largura(t + " " + id); await p.print(`24-tema-${id}-${t}-360`); }
      await p.aba("inicio"); await p.clicar("#fab"); await p.digitar("#gValor", "2000"); await p.avaliar(() => document.querySelector("#gValor").dispatchEvent(new Event("input", { bubbles: true })));
      await p.print(`24-tema-${id}-folha-360`); await p.clicar('.folha-topo [data-act="folha-fechar"]');
      await p.tamanho(1280, 800); await p.recarregar(); await largura("Início PC " + id); await p.print(`24-tema-${id}-inicio-1280`);
    }
    for (const tema of ["noite", "dia"]) {
      await p.avaliar((tema) => localStorage.setItem("caixinhas-orologia-tema", JSON.stringify({ atual: tema, meus: [] })), tema);
      for (const [w, h] of [[360, 780], [320, 640], [1280, 800]]) {
        await p.tamanho(w, h); await p.recarregar(); await p.aba("ajustes/aparencia");
        await largura(`Aparência ${tema} ${w}`);
        const cortado = await p.avaliar(() => [...document.querySelectorAll("#temaBox .tema-card")].filter((c) => c.scrollWidth > c.clientWidth + 1).length);
        igual(cortado, 0, `cartões de tema sem estourar em ${w}px (${tema})`);
        await p.print(`24-aparencia-${tema}-${w}`, true);
      }
    }
  },
  "Nenhuma tela passa da largura": async (p) => {
    await comExemplo(p);
    const TELAS = ["inicio", "mes", "graficos", "cartao", "metas", "calc", "ajustes", "ajustes/caixinhas", "ajustes/dados", "guia", "apoie"];
    for (const [w, h] of [[320, 640], [844, 390], [1280, 800]]) {
      await p.tamanho(w, h); await p.recarregar();
      for (const t of TELAS) {
        await p.aba(t);
        const sobra = await p.avaliar(() => document.documentElement.scrollWidth - window.innerWidth);
        certo(sobra <= 0, `a aba ${t} passa ${sobra}px da largura em ${w}px`);
      }
      await p.aba("inicio"); await p.clicar(w >= 900 ? "#ladoLancar" : "#fab");
      const sobra = await p.avaliar(() => { const c = document.querySelector(".folha-caixa"); return c.scrollWidth - c.clientWidth; });
      certo(sobra <= 0, `a folha passa ${sobra}px da largura em ${w}px`);
      await p.clicar('.folha-topo [data-act="folha-fechar"]');
    }
    // em tela estreita o "Salvo no aparelho" some só da vista: o leitor de tela continua ouvindo
    await p.tamanho(320, 640); await p.recarregar();
    const sync = await p.avaliar(() => { const e = document.querySelector("#syncTxt"), r = e.getBoundingClientRect(), c = getComputedStyle(e); return { display: c.display, w: r.width, vis: c.visibility }; });
    certo(sync.display !== "none" && sync.vis !== "hidden" && sync.w <= 1, "o texto do aviso devia ficar só fora da vista em 320 px: " + JSON.stringify(sync));
    // no PC, Mês, Cartão e Metas usam duas colunas (a lista ao lado do resumo)
    await p.tamanho(1280, 800); await p.recarregar();
    for (const [t, a, b] of [["mes", "#mesResumo", "#mesLista"], ["cartao", "#cartResumo", "#fCompra"], ["metas", "#metasResumo", "#dMeta"]]) {
      await p.aba(t);
      const r = await p.avaliar((a, b) => { const x = document.querySelector(a).getBoundingClientRect(), y = document.querySelector(b).getBoundingClientRect(); return { aL: Math.round(x.left), bL: Math.round(y.left), aT: Math.round(x.top), bT: Math.round(y.top) }; }, a, b);
      certo(r.bL - r.aL > 250, `no PC ${t} devia ter duas colunas (${a} à esquerda, ${b} à direita): ` + JSON.stringify(r));
    }
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
  const p = await novaPagina(cr, base, typeof t !== "function" && !!t.movimento, typeof t !== "function" && !!t.nativo);
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
