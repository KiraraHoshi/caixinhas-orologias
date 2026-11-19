// Gera as imagens do Orolon Caixinhas a partir do app de verdade, num Chrome sem janela (nada é instalado, sem bibliotecas).
// Uso: node scripts/prints-loja.mjs [loja|readme] [número ...]
//   loja   -> loja/pt: 8 capturas 1080×1920 com legenda, numa moldura de celular, e a imagem de destaque 1024×500
//   readme -> docs/: as imagens do README (seis de celular e duas de PC, 1280×800)
//   sem nada, gera os dois conjuntos; os números escolhem só algumas imagens do conjunto (ex.: loja 3 5).
// Os dados são inventados aqui (uma casa com contas comuns; nenhum nome de pessoa nem de banco de verdade) e o "hoje"
// fica preso em 19/11/2026 às 10h30, para o script dar sempre as mesmas imagens. Com "reduzir movimento", nada está no meio
// de uma animação na hora da foto.
import { createServer } from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { abrirChrome } from "../testes/chrome.mjs";

const RAIZ = fileURLToPath(new URL("../", import.meta.url));
const TIPOS = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".webmanifest": "application/manifest+json", ".png": "image/png", ".svg": "image/svg+xml" };
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
const HOJE = [2026, 10, 19, 10, 30]; // 19/11/2026, 10h30 (mês começa em 0)

/* ---- textos das imagens da loja (ordem = ordem na Play) ---- */
const LOJA = {
  destaque: ["Orolon Caixinhas", "O dinheiro do mês dividido em caixinhas, com limite e sem susto", "Sem anúncios · Sem conta · Sem internet"],
  prints: [
    ["inicio", "Seu mês num olhar", "Quanto sobra, quanto dá por dia e o ritmo dos gastos"],
    ["lancar", "Cabe ou não cabe?", "Lance um gasto e veja na hora se cabe na caixinha"],
    ["graficos", "Para onde foi o dinheiro", "Ritmo do mês, caixinhas e os últimos 6 meses"],
    ["mes", "Cada gasto na sua caixinha", "Limites por caixinha, entradas e gastos fixos"],
    ["cartao", "Cartão sem susto", "Fatura, parcelas, assinaturas e quem te deve"],
    ["metas", "Metas que andam", "Quanto falta e em quanto tempo você chega lá"],
    ["calc", "Financiamento sem mistério", "SAC ou PRICE, e quanto a parcela extra economiza"],
    ["temas", "Do seu jeito", "14 temas claros e escuros, ou crie o seu"],
  ],
};
/* ---- imagens do README: [arquivo, cena, tema, largura, altura, escala] ---- */
const README = [
  ["1-inicio.png", "inicio", "noite", 360, 780, 1.5],
  ["2-mes.png", "mes", "noite", 360, 780, 1.5],
  ["3-graficos.png", "graficos", "noite", 360, 780, 1.5],
  ["4-cartao.png", "cartao", "dia", 360, 780, 1.5],
  ["5-temas.png", "temas", "g-lirio", 360, 780, 1.5],
  ["6-calculadoras.png", "calc", "g-ametista", 360, 780, 1.5],
  ["7-pc-inicio.png", "inicio", "noite", 1280, 800, 1],
  ["8-pc-graficos.png", "graficos", "noite", 1280, 800, 1],
];
const TEMA_LOJA = { temas: "g-areia" }; // na loja, as outras cenas ficam no tema padrão (noite)

/* ---- dados inventados ---- */
function dados() {
  const pad = (n) => String(n).padStart(2, "0");
  const [ano, mes0, dia] = HOJE, chave = (d) => d.getFullYear() + "-" + pad(d.getMonth() + 1);
  const mesK = (n) => chave(new Date(ano, mes0 - n, 1)); // n meses antes do atual
  const caixinhas = [
    { id: "moradia", nome: "Moradia", cor: "#8FB8F5", icone: "casa" },
    { id: "mercado", nome: "Mercado", cor: "#8FD3B4", icone: "mercado" },
    { id: "transporte", nome: "Transporte", cor: "#F2A48A", icone: "carro" },
    { id: "saude", nome: "Saúde", cor: "#F28FB8", icone: "saude" },
    { id: "lazer", nome: "Lazer", cor: "#E3C98A", icone: "lazer" },
    { id: "objetivos", nome: "Objetivos", cor: "#C9A6F5", icone: "alvo" },
  ];
  const limitesPadrao = { moradia: 2000, mercado: 1300, transporte: 500, saude: 350, lazer: 700, objetivos: 500 };
  let n = 0;
  const g = (k, d, valor, descricao, caixinha, forma) => ({ id: "g" + (++n), valor, descricao, caixinha, forma, data: k + "-" + pad(d), criado: 1790000000000 + n * 60000 });
  // um mês comum; `v` varia um pouco os valores de um mês para o outro, `extra` acrescenta o que foi daquele mês
  const comum = (k, v, extra = []) => [
    g(k, 6, 498.6 * v, "Mercado do mês", "mercado", "Débito"), g(k, 9, 84 * v, "Feira", "mercado", "Pix"), g(k, 14, 31.5, "Padaria", "mercado", "Pix"),
    g(k, 21, 112.4 * v, "Açougue", "mercado", "Débito"), g(k, 26, 146.3 * v, "Mercado da semana", "mercado", "Débito"),
    g(k, 12, 171.4 * v, "Conta de luz", "moradia", "Pix"), g(k, 18, 76.9, "Água", "moradia", "Pix"), g(k, 23, 118, "Gás", "moradia", "Dinheiro"),
    g(k, 7, 225 * v, "Combustível", "transporte", "Crédito"), g(k, 13, 27.9, "Corrida de aplicativo", "transporte", "Pix"), g(k, 24, 19.5, "Estacionamento", "transporte", "Pix"),
    g(k, 11, 58.7 * v, "Farmácia", "saude", "Débito"),
    g(k, 8, 94 * v, "Pizza com amigos", "lazer", "Pix"), g(k, 20, 62, "Cinema", "lazer", "Crédito"), g(k, 27, 138.5 * v, "Restaurante", "lazer", "Crédito"),
    g(k, 3, 150, "Guardado para a viagem", "objetivos", "Pix"),
    ...extra,
  ].map((x) => Object.assign(x, { valor: Math.round(x.valor * 100) / 100 }));
  const meses = {};
  const salario = (k) => [{ id: "e" + k, valor: 5400, descricao: "Salário", data: k + "-05", criado: 1790000000000 }];
  meses[mesK(5)] = { gastos: comum(mesK(5), 0.96, [g(mesK(5), 16, 180, "Consulta", "saude", "Pix")]), entradas: salario(mesK(5)) };
  meses[mesK(4)] = { gastos: comum(mesK(4), 1.02, [g(mesK(4), 22, 89.9, "Livro", "lazer", "Pix")]), entradas: salario(mesK(4)) };
  meses[mesK(3)] = { gastos: comum(mesK(3), 1.08, [g(mesK(3), 15, 1480, "Conserto do carro", "transporte", "Crédito"), g(mesK(3), 19, 240, "Show", "lazer", "Crédito")]), entradas: salario(mesK(3)) };
  meses[mesK(2)] = { gastos: comum(mesK(2), 0.98, [g(mesK(2), 10, 197, "Curso online", "objetivos", "Pix")]), entradas: salario(mesK(2)) };
  meses[mesK(1)] = { gastos: comum(mesK(1), 1.0, [g(mesK(1), 17, 129.9, "Presente de aniversário", "lazer", "Pix")]), entradas: salario(mesK(1)) };
  // o mês atual, até o dia 19
  const k = mesK(0);
  meses[k] = {
    gastos: [
      g(k, 3, 150, "Guardado para a viagem", "objetivos", "Pix"), g(k, 6, 512.8, "Mercado do mês", "mercado", "Débito"), g(k, 7, 230, "Combustível", "transporte", "Crédito"),
      g(k, 8, 96, "Pizza com amigos", "lazer", "Pix"), g(k, 9, 86, "Feira", "mercado", "Pix"), g(k, 11, 54.7, "Farmácia", "saude", "Débito"),
      g(k, 12, 176.4, "Conta de luz", "moradia", "Pix"), g(k, 13, 28.9, "Corrida de aplicativo", "transporte", "Pix"), g(k, 14, 31.5, "Padaria", "mercado", "Pix"),
      g(k, 15, 62, "Cinema", "lazer", "Crédito"), g(k, 16, 104.9, "Açougue", "mercado", "Débito"), g(k, 18, 78.3, "Água", "moradia", "Pix"),
      g(k, 19, 23.9, "Café com a equipe", "lazer", "Pix"),
    ],
    entradas: salario(k).concat([{ id: "efreela", valor: 800, descricao: "Freela de design", data: k + "-15", criado: 1790000000001 }]),
  };
  // gastos fixos: o app lança sozinho, uma vez por mês, desde o mês de criação
  const fixos = [
    { id: "f1", desc: "Aluguel", valor: 1450, caixinha: "moradia", forma: "Pix", dia: 5, desde: mesK(5), pulados: [] },
    { id: "f2", desc: "Internet", valor: 99.9, caixinha: "moradia", forma: "Débito", dia: 10, desde: mesK(5), pulados: [] },
    { id: "f3", desc: "Academia", valor: 89.9, caixinha: "saude", forma: "Pix", dia: 2, desde: mesK(5), pulados: [] },
  ];
  const cartoes = [{ id: "k1", nome: "Cartão principal", fecha: 28, vence: 5 }, { id: "k2", nome: "Cartão da casa", fecha: 15, vence: 22 }];
  const compras = [
    { id: "c1", cartao: "k1", desc: "Geladeira", valorParcela: 289.9, parcelas: 12, inicio: mesK(3), dono: "" },
    { id: "c2", cartao: "k1", desc: "Notebook", valorParcela: 349, parcelas: 10, inicio: mesK(1), dono: "" },
    { id: "c3", cartao: "k2", desc: "Streaming de música", valorParcela: 21.9, parcelas: 0, inicio: mesK(5), dono: "" },
    { id: "c4", cartao: "k2", desc: "Streaming de filmes", valorParcela: 44.9, parcelas: 0, inicio: mesK(5), dono: "" },
    { id: "c5", cartao: "k2", desc: "Fone de ouvido", valorParcela: 79.9, parcelas: 3, inicio: mesK(0), dono: "Irmã" },
  ];
  const metas = [
    { id: "m1", nome: "Reserva de emergência", onde: "Conta com rendimento diário", alvo: 15000, atual: 6200, aporte: 500, taxa: 13.75 },
    { id: "m2", nome: "Viagem de férias", onde: "Caixinha do banco", alvo: 6000, atual: 2350, aporte: 300, taxa: 13.75 },
  ];
  return { v: 1, caixinhas, limitesPadrao, formas: ["Pix", "Débito", "Crédito", "Dinheiro"], cartoes, compras, recebidos: {}, fixos, metas, taxaRef: 13.75, meses, onboarded: true, guiaVisto: true };
}

/* ---- o que roda na página antes do app: "hoje" preso, dados e tema ---- */
function antesDoApp(hoje, estado, tema) {
  const R = Date, base = new R(hoje[0], hoje[1], hoje[2], hoje[3], hoje[4]).getTime(), t0 = R.now();
  class D extends R { constructor(...a) { if (a.length) super(...a); else super(base + (R.now() - t0)); } static now() { return base + (R.now() - t0); } }
  window.Date = D;
  localStorage.setItem("caixinhas-orologia-v1", JSON.stringify(estado));
  localStorage.setItem("caixinhas-orologia-tema", JSON.stringify({ atual: tema, meus: [] }));
  localStorage.setItem("caixinhas-orologia-backup", JSON.stringify(base)); // backup feito hoje: sem o aviso de backup
}

/* ---- as cenas: cada uma deixa o app na tela que será fotografada ---- */
const CENAS = {
  inicio: async (p) => { await p.aba("inicio"); },
  lancar: async (p) => {
    await p.aba("inicio");
    await p.avaliar(() => document.querySelector("#fab").click()); await espera(300);
    await p.avaliar(() => {
      const v = document.querySelector("#gValor"); v.value = "45,90"; v.dispatchEvent(new Event("input", { bubbles: true }));
      document.querySelector('#gCats input[value="saude"]').click();
      const d = document.querySelector("#gDesc"); d.value = "Remédio"; d.dispatchEvent(new Event("input", { bubbles: true }));
      document.activeElement && document.activeElement.blur();
    });
  },
  graficos: async (p) => { await p.aba("graficos"); },
  mes: async (p) => { await p.aba("mes"); },
  cartao: async (p) => { await p.aba("cartao"); },
  metas: async (p) => { await p.aba("metas"); },
  calc: async (p) => {
    await p.aba("calc");
    await p.avaliar(() => {
      document.querySelector('[data-calc="fin"]').click();
      for (const [id, v] of [["iRenda", "9000"], ["iExtra", "500"]]) { const e = document.querySelector("#" + id); e.value = v; e.dispatchEvent(new Event("input", { bubbles: true })); }
      document.activeElement && document.activeElement.blur();
    });
    await espera(200);
    await p.avaliar(() => { const r = document.querySelector("#c-fin .fin-lado > div:nth-child(2) h4"); if (r && innerWidth < 900) scrollTo(0, Math.max(0, r.getBoundingClientRect().top + scrollY - 16)); });
  },
  temas: async (p) => {
    await p.aba("ajustes/aparencia");
    await p.avaliar(() => { const h = [...document.querySelectorAll("#temaBox h3")].find((x) => x.textContent.trim() === "Galeria"); if (h) { const a = h.previousElementSibling; scrollTo(0, Math.max(0, (a ? a.getBoundingClientRect().bottom : h.getBoundingClientRect().top - 12) + scrollY + 2)); } });
  },
};

/* ---- moldura das imagens da loja ---- */
const CSS_BASE = `*{margin:0;box-sizing:border-box}body{font-family:"Segoe UI",system-ui,sans-serif;color:#F2EEF9;overflow:hidden;background:radial-gradient(120% 60% at 50% 0%,#3a3068 0%,#1a1530 46%,#0c0a14 100%)}
.cel{background:#07060d;border:2px solid #2b2540;box-shadow:0 30px 80px #0009,inset 0 0 0 2px #15121f}.cel img{display:block}`;
const htmlPrint = (img, titulo, sub) => `<!doctype html><meta charset="utf-8"><style>${CSS_BASE}
body{width:1080px;height:1920px;text-align:center}
.topo{height:500px;display:flex;flex-direction:column;justify-content:center;align-items:center;gap:30px;padding:30px 70px 10px}
h1{font-family:Constantia,Georgia,serif;font-size:84px;line-height:1.08;letter-spacing:-.01em;font-weight:700;text-wrap:balance;color:#F5EBD2}
p{font-size:42px;line-height:1.25;color:#CFC6EE;text-wrap:balance}
.cel{width:760px;height:1320px;border-radius:92px;margin:0 auto;padding:18px}.cel img{width:720px;height:1280px;border-radius:74px}</style>
<div class="topo"><h1>${titulo}</h1><p>${sub}</p></div><div class="cel"><img src="${img}"></div>`;
const htmlDestaque = (icone, a, b, [nome, frase, selos]) => `<!doctype html><meta charset="utf-8"><style>${CSS_BASE}
body{width:1024px;height:500px;background:radial-gradient(90% 120% at 22% 18%,#3d3270 0%,#1a1530 52%,#0c0a14 100%);position:relative}
.ic{position:absolute;left:64px;top:70px;width:112px;height:112px;border-radius:26px;box-shadow:0 12px 30px #0007}
h1{position:absolute;left:64px;top:200px;font-family:Constantia,Georgia,serif;font-size:56px;letter-spacing:-.01em;font-weight:700;white-space:nowrap;color:#F5EBD2}
.f{position:absolute;left:64px;top:282px;width:440px;font-size:25px;line-height:1.3;color:#E4DCF6}.s{position:absolute;left:64px;top:404px;font-size:17px;font-weight:600;color:#B9B3F2;white-space:nowrap}
.cel{position:absolute;width:236px;height:412px;border-radius:30px;padding:6px}.cel img{width:220px;height:396px;border-radius:24px;object-fit:cover;object-position:top}
.c1{left:570px;top:70px;transform:rotate(-5deg)}.c2{left:782px;top:36px;transform:rotate(4deg)}</style>
<img class="ic" src="${icone}"><h1>${nome}</h1><div class="f">${frase}</div><div class="s">${selos}</div>
<div class="cel c1"><img src="${a}"></div><div class="cel c2"><img src="${b}"></div>`;

/* ---- servidor e páginas ---- */
function servir() {
  const srv = createServer(async (req, res) => {
    let c = decodeURIComponent(new URL(req.url, "http://x").pathname); if (c.endsWith("/")) c += "index.html";
    const f = resolve(RAIZ, "." + c);
    if (!f.startsWith(resolve(RAIZ))) { res.writeHead(403); return res.end(); }
    try { const d = await readFile(f); res.writeHead(200, { "content-type": TIPOS[extname(f)] || "application/octet-stream", "cache-control": "no-store" }); res.end(d); } catch { res.writeHead(404); res.end(); }
  });
  return new Promise((ok) => srv.listen(0, "127.0.0.1", () => ok(srv)));
}
async function pagina(cr, w, h, escala) {
  const { browserContextId } = await cr.enviar("Target.createBrowserContext");
  const { targetId } = await cr.enviar("Target.createTarget", { url: "about:blank", browserContextId });
  const { sessionId } = await cr.enviar("Target.attachToTarget", { targetId, flatten: true });
  const s = (m, q) => cr.enviar(m, q, sessionId);
  await s("Runtime.enable"); await s("Page.enable");
  await s("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: escala, mobile: w < 900 });
  await s("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  const avaliar = async (fn, ...args) => {
    const r = await s("Runtime.evaluate", { expression: `(${fn})(...${JSON.stringify(args)})`, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error("na página: " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result.value;
  };
  return {
    s, avaliar,
    abrirApp: async (url, estado, tema) => {
      await s("Page.addScriptToEvaluateOnNewDocument", { source: `(${antesDoApp})(${JSON.stringify(HOJE)}, ${JSON.stringify(estado)}, ${JSON.stringify(tema)})` });
      await s("Page.navigate", { url });
      for (let i = 0; i < 200; i++) { try { if (await avaliar(() => document.readyState === "complete" && !!window.TemaCx)) break; } catch {} await espera(50); }
      await espera(400);
    },
    aba: async (t) => { await avaliar((x) => { location.hash = "#" + x; }, t); await espera(350); },
    conteudo: async (html) => { const { frameTree } = await s("Page.getFrameTree"); await s("Page.setDocumentContent", { frameId: frameTree.frame.id, html }); await avaliar(() => Promise.all([...document.images].map((i) => i.decode()))); await espera(150); },
    foto: async (formato) => (await s("Page.captureScreenshot", formato === "jpeg" ? { format: "jpeg", quality: 92 } : { format: "png" })).data,
    fechar: () => cr.enviar("Target.disposeBrowserContext", { browserContextId }).catch(() => {}),
  };
}
// abre o app com os dados, monta a cena e fotografa a tela (PNG em base64)
async function fotografar(cr, base, cena, tema, w, h, escala) {
  const p = await pagina(cr, w, h, escala);
  try {
    await p.abrirApp(`${base}/index.html`, dados(), tema);
    await CENAS[cena](p);
    await espera(500);
    await p.avaliar(() => { const t = document.querySelector("#toast"); if (t) t.hidden = true; });
    return await p.foto("png");
  } finally { await p.fechar(); }
}

/* ---- execução ---- */
const args = process.argv.slice(2), conjuntos = args.filter((a) => a === "loja" || a === "readme"), quais = args.filter((a) => /^\d+$/.test(a)).map(Number);
const srv = await servir(), base = `http://127.0.0.1:${srv.address().port}`;
const cr = await abrirChrome({ prefixo: "caixinhas-prints-", extra: ["--lang=pt-BR", "--accept-lang=pt-BR", "--hide-scrollbars"] });
try {
  if (!conjuntos.length || conjuntos.includes("loja")) {
    const pasta = join(RAIZ, "loja", "pt"), telas = {};
    await mkdir(pasta, { recursive: true });
    for (const [i, [cena, titulo, sub]] of LOJA.prints.entries()) {
      if (quais.length && !quais.includes(i + 1)) continue;
      // tela do celular em 405×720 (9:16), fotografada a 720×1280 para caber na moldura
      telas[cena] = "data:image/png;base64," + await fotografar(cr, base, cena, TEMA_LOJA[cena] || "noite", 405, 720, 720 / 405);
      const m = await pagina(cr, 1080, 1920, 1);
      await m.conteudo(htmlPrint(telas[cena], titulo, sub));
      await writeFile(join(pasta, `print-${i + 1}-${cena}.jpg`), Buffer.from(await m.foto("jpeg"), "base64"));
      await m.fechar();
      console.log(`loja/pt/print-${i + 1}-${cena}.jpg`);
    }
    if (telas.inicio && telas.graficos) {
      const icone = "data:image/png;base64," + (await readFile(join(RAIZ, "icon-512.png"))).toString("base64");
      const m = await pagina(cr, 1024, 500, 1);
      await m.conteudo(htmlDestaque(icone, telas.inicio, telas.graficos, LOJA.destaque));
      await writeFile(join(pasta, "destaque-1024x500.jpg"), Buffer.from(await m.foto("jpeg"), "base64"));
      await m.fechar();
      console.log("loja/pt/destaque-1024x500.jpg");
    }
  }
  if (!conjuntos.length || conjuntos.includes("readme")) {
    const pasta = join(RAIZ, "docs");
    await mkdir(pasta, { recursive: true });
    for (const [i, [arq, cena, tema, w, h, escala]] of README.entries()) {
      if (quais.length && !quais.includes(i + 1)) continue;
      await writeFile(join(pasta, arq), Buffer.from(await fotografar(cr, base, cena, tema, w, h, escala), "base64"));
      console.log("docs/" + arq);
    }
  }
} finally { await cr.fechar(); srv.close(); }
