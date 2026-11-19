// Testes do Caixinhas: abre o app de verdade num Chrome sem janela e confere o que cada teste pede.
// Uso: node testes/rodar.mjs ["parte do nome"]        (prints em testes/prints/)
// Não usa nenhuma biblioteca: fala com o Chrome pelo protocolo DevTools com o WebSocket do próprio Node.
import { createServer } from "node:http";
import { readFile, mkdir, writeFile, mkdtemp, rm } from "node:fs/promises";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { abrirChrome } from "./chrome.mjs";

const RAIZ = fileURLToPath(new URL("../", import.meta.url));
const PRINTS = join(RAIZ, "testes", "prints");
const TIPOS = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".webmanifest": "application/manifest+json", ".png": "image/png", ".svg": "image/svg+xml" };
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

function servir() {
  const srv = createServer(async (req, res) => {
    let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (p.endsWith("/")) p += "index.html";
    const f = resolve(RAIZ, "." + p);
    if (!f.startsWith(resolve(RAIZ))) { res.writeHead(403); return res.end(); }
    if (Number(process.env.CX_DEMORA) > 0) await espera(Number(process.env.CX_DEMORA)); // CX_DEMORA=ms: servidor lento (acha esperas frágeis)
    try { const d = await readFile(f); res.writeHead(200, { "content-type": TIPOS[extname(f)] || "application/octet-stream", "cache-control": "no-store" }); res.end(d); }
    catch { res.writeHead(404); res.end(); }
  });
  return new Promise((ok) => srv.listen(0, "127.0.0.1", () => ok(srv)));
}

// Cada teste ganha uma página com armazenamento próprio (começa sempre do zero).
// CX_LENTO=N (ex.: 8) deixa o processador da página N vezes mais lento: simula um servidor ocupado, para achar esperas frágeis.
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
  if (Number(process.env.CX_LENTO) > 1) await s("Emulation.setCPUThrottlingRate", { rate: Number(process.env.CX_LENTO) });
  if (nativo) await s("Page.addScriptToEvaluateOnNewDocument", { source: `(${capacitorFalso})()` }); // finge o app Android
  await s("Page.navigate", { url: `${base}/index.html` });
  await espera(700);
  for (const fim = Date.now() + 5000; Date.now() < fim; await espera(50)) { // num servidor ocupado a primeira abertura pode passar dos 700 ms
    const r = await s("Runtime.evaluate", { expression: "document.readyState === 'complete' && !!window.TemaCx", returnByValue: true }).catch(() => null);
    if (r && r.result && r.result.value) break;
  }
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
    // espera a condição (uma função da página) ficar verdadeira, sem tempo fixo: devolve o último valor (até 5 s)
    ate: async (fn, ...args) => { let v; for (const fim = Date.now() + 5000; Date.now() < fim; await espera(50)) { try { v = await avaliar(fn, ...args); } catch (e) { v = undefined; } if (v) return v; } return v; },
    // recarrega e espera o documento novo terminar de carregar (a página velha tem a marca __velha; a nova, não)
    recarregar: async () => {
      await avaliar(() => { window.__velha = true; location.reload(); }).catch(() => {}); await espera(700);
      await p.ate(() => !window.__velha && document.readyState === "complete");
    },
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
  const N = (window.__nativo = { chamadas: [], voltar: null, urlAberta: null, minimizou: 0, pediu: 0, responder: "granted", agendadas: [], barras: [] });
  // "__launch" no localStorage = endereço com que o Android abriu o app (o toque no widget com o app fechado).
  // Como no Capacitor: getLaunchUrl devolve sempre o mesmo endereço (até num recarregar ou ao voltar de outra página), e o
  // appUrlOpen da abertura fica guardado até alguém ouvir e sai uma vez só por abertura do app. Uma abertura do app = uma
  // sessão da WebView (sessionStorage); abrir o app do zero nos testes limpa o sessionStorage.
  const abertura = () => ler("__launch", null);
  const recarga = () => { try { if (sessionStorage.getItem("__urlEntregue")) return true; sessionStorage.setItem("__urlEntregue", "1"); return false; } catch (e) { return false; } };
  window.Capacitor = { isNativePlatform: () => true, Plugins: {
    App: {
      addListener: (ev, fn) => {
        if (ev === "backButton") N.voltar = fn;
        if (ev === "appUrlOpen") { N.urlAberta = fn; const u = abertura(); if (u && !recarga()) setTimeout(() => fn({ url: u }), 0); }
        return Promise.resolve({ remove() {} });
      },
      getLaunchUrl: async () => { const u = abertura(); return u ? { url: u } : {}; },
      minimizeApp: async () => { N.minimizou++; },
    },
    // o plugin de barras do sistema do próprio Capacitor: anota cada estilo pedido (e se a página já estava à vista na hora)
    SystemBars: { setStyle: async (o) => { N.barras.push({ style: o && o.style, bar: o && o.bar, corpo: !!document.body }); } },
    Caixinhas: {
      widget: async (a) => { N.chamadas.push(["widget", JSON.parse(JSON.stringify(a))]); },
      compartilhar: async (a) => { N.chamadas.push(["compartilhar", a]); },
      aparelho: async () => ({ marca: "tst1" }),
      // "__escolha" no localStorage = o que o seletor do Android devolve (com "sub", o plugin achou ou criou a subpasta do app)
      escolherPastaBackup: async () => ler("__escolha", { uri: "content://pasta-de-teste", nome: "Backup" }),
      listarBackups: async (a) => { N.chamadas.push(["listarBackups", { uri: a.uri, sub: a.sub }]); return { backups: Object.keys(ler("__pasta", {})).map((n) => ({ doc: n, nome: n, modificado: 0 })) }; },
      lerBackup: async ({ doc }) => ({ texto: ler("__pasta", {})[doc] }),
      // "__devolve" = o que a gravação responde (ex.: { sub } quando o plugin recriou a subpasta apagada)
      gravarBackup: async (a) => {
        N.chamadas.push(["gravarBackup", { nome: a.nome, grupo: a.grupo, manter: a.manter, uri: a.uri, sub: a.sub }]);
        const o = ler("__pasta", {}); o[a.nome] = a.texto;
        Object.keys(o).filter((n) => n.endsWith(a.grupo)).sort().reverse().slice(a.manter).forEach((n) => delete o[n]);
        localStorage.setItem("__pasta", JSON.stringify(o));
        return ler("__devolve", undefined);
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
// Projeto Android como o "npx cap add android" deixa (modelo do Capacitor 8 com o identificador do app), numa pasta temporária.
// Serve para rodar scripts/plugin-android.mjs sem o Android instalado. Devolve a pasta android/app.
async function projetoAndroidFalso(pasta) {
  const app = join(pasta, "android", "app");
  const arquivos = {
    "src/main/java/com/joah/caixinhas/MainActivity.java": "package com.joah.caixinhas;\n\nimport com.getcapacitor.BridgeActivity;\n\npublic class MainActivity extends BridgeActivity {}\n",
    "src/main/AndroidManifest.xml": `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">

    <application
        android:allowBackup="true"
        android:icon="@mipmap/ic_launcher"
        android:label="@string/app_name"
        android:roundIcon="@mipmap/ic_launcher_round"
        android:supportsRtl="true"
        android:theme="@style/AppTheme">

        <activity
            android:name=".MainActivity"
            android:launchMode="singleTask"
            android:exported="true">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>

        <provider
            android:name="androidx.core.content.FileProvider"
            android:authorities="\${applicationId}.fileprovider"
            android:exported="false"
            android:grantUriPermissions="true">
            <meta-data
                android:name="android.support.FILE_PROVIDER_PATHS"
                android:resource="@xml/file_paths"></meta-data>
        </provider>
    </application>

    <!-- Permissions -->

    <uses-permission android:name="android.permission.INTERNET" />
</manifest>
`,
    "build.gradle": `apply plugin: 'com.android.application'

android {
    namespace = "com.joah.caixinhas"
    compileSdk = rootProject.ext.compileSdkVersion
    defaultConfig {
        applicationId "com.joah.caixinhas"
        minSdkVersion rootProject.ext.minSdkVersion
        targetSdkVersion rootProject.ext.targetSdkVersion
        versionCode 1
        versionName "1.0"
        testInstrumentationRunner "androidx.test.runner.AndroidJUnitRunner"
        aaptOptions {
            ignoreAssetsPattern = '!.svn:!.git:!.ds_store:!*.scc:.*:!CVS:!thumbs.db:!picasa.ini:!*~'
        }
    }
    buildTypes {
        release {
            minifyEnabled false
            proguardFiles getDefaultProguardFile('proguard-android.txt'), 'proguard-rules.pro'
        }
    }
}
`,
    "src/main/res/values/strings.xml": `<?xml version='1.0' encoding='utf-8'?>
<resources>
    <string name="app_name">Orolon Caixinhas</string>
    <string name="title_activity_main">Orolon Caixinhas</string>
    <string name="package_name">com.joah.caixinhas</string>
    <string name="custom_url_scheme">com.joah.caixinhas</string>
</resources>
`,
    "src/main/res/xml/file_paths.xml": `<?xml version="1.0" encoding="utf-8"?>\n<paths xmlns:android="http://schemas.android.com/apk/res/android">\n    <external-path name="my_images" path="." />\n    <cache-path name="my_cache_images" path="." />\n</paths>\n`,
  };
  for (const [f, t] of Object.entries(arquivos)) { const p = join(app, f); await mkdir(join(p, ".."), { recursive: true }); await writeFile(p, t); }
  return app;
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
// importa um backup pelo mesmo caminho da pessoa (Ajustes › Dados › Importar backup › Substituir); obj pode ser texto
const importarBackup = async (p, obj) => {
  await p.aba("ajustes/dados");
  await p.avaliar((txt) => { const i = document.querySelector("#impFile"), dt = new DataTransfer(); dt.items.add(new File([txt], "backup.json", { type: "application/json" })); i.files = dt.files; i.dispatchEvent(new Event("change", { bubbles: true })); }, typeof obj === "string" ? obj : JSON.stringify(obj));
  certo(await p.ate(() => !!document.querySelector('#impConfirm [data-act="imp-ok"]')), "a importação não pediu confirmação: " + await p.texto("#impConfirm"));
  await p.clicar('[data-act="imp-ok"]'); await p.espera(250);
};
const guardado = (p) => p.avaliar(() => JSON.parse(localStorage.getItem("caixinhas-orologia-v1")));
// Pasta do backup no PC: a janela de escolher pasta não abre sem pessoa, então os testes usam a pasta particular do navegador,
// que tem os mesmos comandos. "caminho" = subpastas a partir dela. SUBPASTA é a pasta que o app cria no lugar escolhido.
const SUBPASTA = "Orolon Caixinhas";
// o que há na pasta (pastas terminam em "/"), em ordem; null se ela não existe
const pastaPC = (p, caminho = []) => p.avaliar(async (caminho) => {
  try { let d = await navigator.storage.getDirectory(); for (const n of caminho) d = await d.getDirectoryHandle(n);
    const r = []; for await (const [n, h] of d.entries()) r.push(h.kind === "directory" ? n + "/" : n); return r.sort(); } catch (e) { return null; }
}, caminho);
const lerPC = (p, caminho, nome) => p.avaliar(async (caminho, nome) => { try { let d = await navigator.storage.getDirectory(); for (const n of caminho) d = await d.getDirectoryHandle(n); return await (await (await d.getFileHandle(nome)).getFile()).text(); } catch (e) { return null; } }, caminho, nome);
const criarPC = (p, caminho, nome, texto) => p.avaliar(async (caminho, nome, texto) => { let d = await navigator.storage.getDirectory(); for (const n of caminho) d = await d.getDirectoryHandle(n, { create: true }); if (nome) { const w = await (await d.getFileHandle(nome, { create: true })).createWritable(); await w.write(texto); await w.close(); } }, caminho, nome, texto);
// o seletor de pastas devolve a pasta do caminho dado
const seletorPC = (p, caminho = []) => p.avaliar((caminho) => { window.showDirectoryPicker = async () => { let d = await navigator.storage.getDirectory(); for (const n of caminho) d = await d.getDirectoryHandle(n, { create: true }); return d; }; }, caminho);
const arqHoje = (p) => p.avaliar(() => { const d = new Date(); return "caixinhas-backup-" + d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0") + ".json"; });
// com um gasto lançado (o primeiro arquivo sai na hora), escolhe a pasta pelo botão dos Ajustes
const escolherPastaPC = async (p, caminho) => { await seletorPC(p, caminho); await p.clicar('[data-act="onb-skip"]'); await lancar(p, 50, "Cinema"); await p.aba("ajustes/dados"); await p.clicar('[data-act="bkp-pasta"]'); await p.espera(600); };
// texto canônico (chaves em ordem): compara dados sem depender da ordem das chaves
const canon = (v) => JSON.stringify(v, (k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((c) => [c, x[c]])) : x));
// confere que cada campo do backup voltou igual depois da importação. O app só pode ter acrescentado o que é dele:
// campos que faltavam (com o valor de fábrica) e os gastos fixos que ele lança sozinho (com fixoId), no fim da lista do mês.
const conferirIntacto = (antes, depois, nome) => {
  for (const k of Object.keys(antes)) {
    if (k !== "meses") { igual(canon(depois[k]), canon(antes[k]), `${nome}: campo ${k}`); continue; }
    for (const mk of Object.keys(antes.meses)) {
      const a = antes.meses[mk], d = depois.meses[mk];
      certo(d, `${nome}: o mês ${mk} sumiu`);
      for (const c of Object.keys(a)) {
        if (c !== "gastos") { igual(canon(d[c]), canon(a[c]), `${nome}: ${mk}.${c}`); continue; }
        igual(canon(d.gastos.slice(0, a.gastos.length)), canon(a.gastos), `${nome}: gastos de ${mk}`);
        certo(d.gastos.slice(a.gastos.length).every((g) => g.fixoId), `${nome}: ${mk} ganhou gastos que não são fixos`);
      }
    }
    for (const mk of Object.keys(depois.meses).filter((m) => !(m in antes.meses))) certo((depois.meses[mk].gastos || []).every((g) => g.fixoId), `${nome}: mês ${mk} novo com gastos que não são fixos`);
  }
};
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
    // PIN 1234 e backup feitos na 1.9 (o PIN no formato que a 1.9 grava: SHA-256 de "sal:pin")
    await p.avaliar(async () => {
      const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("sal19:1234"));
      localStorage.setItem("caixinhas-orologia-pin", JSON.stringify({ h: [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join(""), salt: "sal19", m: "s", n: 4, tempo: 0 }));
      localStorage.setItem("caixinhas-orologia-backup", JSON.stringify(Date.now()));
    });
    await p.recarregar();
    certo(await p.visivel("#trava"), "com o PIN da 1.9, o app abre travado");
    for (const d of "1234") await p.clicar(`#trava [data-tk="${d}"]`);
    await p.espera(500);
    igual(await p.visivel("#trava"), false, "o PIN da 1.9 destrava a 2.0");
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
    await p.aba("ajustes/dados");
    certo((await p.texto("#ajOnde")).includes("Último backup: hoje"), "a data do último backup da 1.9 continua lida: " + await p.texto("#ajOnde"));
  },
  "Android: quem vem da 1.9 continua com a pasta do backup escolhida": { nativo: true, fn: async (p) => {
    await semearContas(p);
    await p.avaliar(() => { localStorage.setItem("caixinhas-orologia-pasta", JSON.stringify({ uri: "content://pasta-de-teste", nome: "Backup" })); localStorage.setItem("caixinhas-orologia-backup-pasta", JSON.stringify(Date.now() - 3600000)); });
    await p.recarregar(); await p.aba("ajustes/dados"); await p.espera(300);
    certo((await p.texto("#bkpBox")).includes("Gravando na pasta “Backup”"), "a pasta escolhida na 1.9 continua: " + await p.texto("#bkpBox"));
  } },
  "Voltar ao app num mês novo atualiza o Início e o widget, sem mudar o mês escolhido no Mês": { nativo: true, fn: async (p) => {
    // relógio do teste: Date com um deslocamento ajustável (window.__desloc, em ms); document.hidden controlado por window.__oculto
    await p.injetar("(() => { const R = Date; class D extends R { constructor(...a) { if (a.length) super(...a); else super(R.now() + (window.__desloc || 0)); } static now() { return R.now() + (window.__desloc || 0); } } window.Date = D; Object.defineProperty(document, 'hidden', { configurable: true, get: () => !!window.__oculto }); })();");
    await p.recarregar(); await comExemplo(p);
    await p.aba("mes"); await p.clicar('#v-mes [data-act="mes-prev"]');
    const escolhido = await p.texto("#mesLabel");
    await p.aba("inicio");
    const antes = await p.avaliar(() => window.__nativo.chamadas.filter((x) => x[0] === "widget").length);
    const prox = await p.avaliar(() => {
      window.__oculto = true; document.dispatchEvent(new Event("visibilitychange"));
      const agora = new Date(), alvo = new Date(agora.getFullYear(), agora.getMonth() + 1, 1, 10, 0, 0);
      window.__desloc = alvo.getTime() - Date.now() + (window.__desloc || 0);
      window.__oculto = false; document.dispatchEvent(new Event("visibilitychange"));
      const pad = (n) => String(n).padStart(2, "0");
      return { k: alvo.getFullYear() + "-" + pad(alvo.getMonth() + 1), nome: alvo.toLocaleDateString("pt-BR", { month: "long" }) };
    });
    await p.espera(300);
    igual((await p.texto("#inResumo .n-mes")).toLowerCase(), prox.nome.toLowerCase(), "o Início passa para o mês novo ao voltar ao app");
    const ws = await p.avaliar(() => window.__nativo.chamadas.filter((x) => x[0] === "widget").map((x) => x[1]));
    certo(ws.length > antes && ws[ws.length - 1].mes === prox.k, "o widget recebe o mês novo ao voltar ao app: " + JSON.stringify(ws.slice(antes)));
    await p.aba("mes");
    igual(await p.texto("#mesLabel"), escolhido, "o Mês continua no mês que a pessoa escolheu");
  } },
  "Backup legítimo passa pela limpeza da importação sem mudar nada": async (p) => {
    const casos = [];
    // 1) os exemplos que o próprio app grava
    await comExemplo(p); casos.push(["exemplos do app", await guardado(p)]);
    // 2) o estado de quem vem da 1.9 (o mesmo do teste da atualização), do jeito que estava guardado
    await semearContas(p); casos.push(["estado da 1.9", await guardado(p)]);
    // 3) os dados do script das imagens da loja (a função dados() do próprio script, com o hoje de verdade)
    const fonte = readFileSync(join(RAIZ, "scripts", "prints-loja.mjs"), "utf8");
    const corpo = fonte.slice(fonte.indexOf("function dados() {"), fonte.indexOf("/* ---- o que roda na página antes do app"));
    const h = new Date(); casos.push(["dados das imagens da loja", new Function("HOJE", corpo + "\nreturn dados();")([h.getFullYear(), h.getMonth(), h.getDate()])]);
    // 4) valores estranhos mas legítimos: cor em minúsculas e #RGB, centavos, descrição vazia, gasto de caixinha apagada,
    //    forma removida, parcelas de 1 a 48 e assinatura encerrada, dias de 1 a 31, limites do mês, saldo inicial, entradas
    const hoje = new Date(), pad = (n) => String(n).padStart(2, "0"), cur = hoje.getFullYear() + "-" + pad(hoje.getMonth() + 1);
    const ult = new Date(hoje.getFullYear(), hoje.getMonth() + 1, 0).getDate(), antes = "2025-02", r2 = (v) => Math.round(v * 100) / 100;
    casos.push(["valores estranhos mas legítimos", {
      v: 1, onboarded: true, guiaVisto: false,
      caixinhas: [{ id: "a", nome: "Casa", cor: "#abcdef", ajuda: "", icone: "casa" }, { id: "b", nome: "Rua", cor: "#abc" }, { id: "c", nome: "Ç ã é — 30 letras de nome aqui!", cor: "#9C9BF5", ajuda: "Para <tudo> & \"aspas\"" }],
      limitesPadrao: { a: 1000, b: 250.55, c: 0 },
      formas: ["Pix", "Vale-refeição"],
      cartoes: Array.from({ length: 31 }, (_, i) => ({ id: "k" + i, nome: "Cartão " + (i + 1), fecha: i + 1, vence: 31 - i })),
      compras: Array.from({ length: 48 }, (_, i) => ({ id: "c" + i, cartao: "k" + (i % 31), desc: i ? "Compra " + i : "", valorParcela: r2(10.05 + i * 1.11), parcelas: i + 1, inicio: i % 2 ? cur : antes, dono: i % 5 ? "" : "Irmã", criado: 1790000000000 + i }))
        .concat([{ id: "s1", cartao: "k0", desc: "Assinatura encerrada", valorParcela: 19.9, parcelas: 0, inicio: antes, dono: "", fim: cur }]),
      fixos: Array.from({ length: 31 }, (_, i) => ({ id: "f" + i, desc: "Fixo " + (i + 1), valor: r2(1.01 * (i + 1)), caixinha: i === 3 ? "apagada" : "a", forma: i === 4 ? "Cheque" : "Pix", dia: i + 1, desde: cur, pulados: [cur] })),
      metas: [{ id: "m1", nome: "Reserva", onde: "", alvo: 1000.01, atual: 0, aporte: 0, taxa: 0 }, { id: "m2", nome: "Batida", onde: "Banco", alvo: 10, atual: 12.34, aporte: 5.5, taxa: 13.75 }],
      recebidos: { [cur]: { "Irmã": true } },
      taxaRef: 10.65,
      meses: {
        [cur]: { gastos: [
          { id: "g1", valor: 0.01, descricao: "", caixinha: "apagada", forma: "Cheque", data: cur + "-01", criado: 1790000000000 },
          { id: "g2", valor: 1234.56, descricao: "Último dia", caixinha: "b", forma: "Pix", data: cur + "-" + pad(ult), criado: 1790000000001, ex: true },
        ], entradas: [{ id: "e1", valor: 5400.5, descricao: "Salário", data: cur + "-05", criado: 1790000000002 }], limites: { a: 900.5, b: 0 }, saldoInicial: 1234.56 },
        [antes]: { gastos: [{ id: "g3", valor: 99.99, descricao: "Fevereiro", caixinha: "a", forma: "Débito", data: antes + "-28", criado: 1790000000003, fixoId: "f0" }] },
      },
    }]);
    for (const [nome, estado] of casos) {
      await importarBackup(p, estado);
      conferirIntacto(estado, await guardado(p), nome);
    }
  },
  "Backup adulterado com marcação HTML não roda nada em nenhuma tela": async (p) => {
    // cada campo que vai para a tela recebe uma marcação que, se entrar crua no HTML, grava window.__xss
    const X = '"><img src=x onerror="window.__xss=(window.__xss||0)+1">', pad = (n) => String(n).padStart(2, "0");
    const hoje = new Date(), cur = hoje.getFullYear() + "-" + pad(hoje.getMonth() + 1);
    await comExemplo(p);
    // primeiro, a contagem da confirmação: um "gastos" ou "metas" que não é lista não pode levar marcação ao aviso
    await p.aba("ajustes/dados");
    await p.avaliar((txt) => { const i = document.querySelector("#impFile"), dt = new DataTransfer(); dt.items.add(new File([txt], "b.json")); i.files = dt.files; i.dispatchEvent(new Event("change", { bubbles: true })); },
      JSON.stringify({ caixinhas: [{ id: "a", nome: "A", cor: "#9C9BF5" }], compras: { length: X }, metas: { length: X }, meses: { [cur]: { gastos: { length: X } } } }));
    await p.espera(600);
    igual(await p.avaliar(() => window.__xss), undefined, "a confirmação da importação rodou a marcação do backup");
    await p.clicar('[data-act="imp-no"]');
    const mal = {
      onboarded: true, guiaVisto: true, taxaRef: X,
      caixinhas: [{ id: "a", nome: X, cor: X, ajuda: X, icone: X }, { id: X, nome: "Outra", cor: "red;background:url(x)" }, X, null, 5],
      limitesPadrao: { a: X },
      formas: [X, "Pix", { x: X }],
      cartoes: [{ id: "k1", nome: X, fecha: X, vence: X }, X],
      compras: [{ id: "c1", cartao: "k1", desc: X, valorParcela: X, parcelas: X, inicio: cur, dono: X }, { id: "c2", cartao: "k1", desc: "Assinatura", valorParcela: 10, parcelas: 0, inicio: X, dono: "", fim: X }],
      fixos: [{ id: "f1", desc: X, valor: X, caixinha: "a", forma: X, dia: X, desde: cur, pulados: [] }, X],
      metas: [{ id: "m1", nome: X, onde: X, alvo: X, atual: X, aporte: X, taxa: X }, X],
      recebidos: { [cur]: { [X]: true } },
      tabelas: { ano: X, inss: { faixas: X }, irrf: { faixas: [[X, X, X]] }, fgts: X },
      meses: {
        [cur]: { gastos: [{ id: "g1", valor: X, descricao: X, caixinha: "a", forma: X, data: X }, { id: X, valor: 5, descricao: "ok", caixinha: X, forma: "Pix", data: cur + "-02" }, X, null],
          entradas: [{ id: "e1", valor: X, descricao: X, data: X }], limites: { a: X }, saldoInicial: X },
        [X]: { gastos: [{ id: "g9", valor: 1, descricao: X, caixinha: "a", forma: "Pix", data: X }] },
      },
    };
    await importarBackup(p, mal);
    const conferir = async (onde) => {
      await p.espera(400); // a imagem quebrada avisa (onerror) depois de tentar carregar
      igual(await p.avaliar(() => window.__xss), undefined, "a marcação do backup rodou em " + onde);
      igual(await p.avaliar(() => document.querySelectorAll("img").length), 0, "apareceu uma imagem que veio do backup em " + onde);
    };
    for (const t of ["inicio", "mes", "graficos", "cartao", "metas", "calc", "ajustes", "ajustes/caixinhas", "ajustes/pagamento", "ajustes/dados", "guia"]) { await p.aba(t); await conferir(t); }
    // a lista do Mês com todos os meses, a folha de lançar e a edição de um gasto
    await p.aba("mes"); await p.avaliar(() => { const c = document.querySelector("#fTodos"); c.checked = true; c.dispatchEvent(new Event("change", { bubbles: true })); }); await conferir("Mês com todos os meses");
    await p.clicar("#fab"); await conferir("folha de lançar");
    await p.clicar('.folha-topo [data-act="folha-fechar"]');
    await p.clicar("#mesLista .n-lanc"); await conferir("edição de um gasto");
    await p.clicar('.folha-topo [data-act="folha-fechar"]');
    // e depois de abrir de novo (a limpeza vale também para o que já está guardado)
    await p.recarregar();
    for (const t of ["inicio", "mes", "cartao", "metas"]) { await p.aba(t); await conferir(t + " depois de reabrir"); }
  },
  "Backup estragado não derruba o app; se o desenho falhar, a importação volta atrás e avisa": async (p) => {
    const pad = (n) => String(n).padStart(2, "0"), h = new Date(), cur = h.getFullYear() + "-" + pad(h.getMonth() + 1);
    await comExemplo(p);
    // 1) itens malformados: gasto sem data, caixinha que não é objeto, entrada vazia, compra sem início, cartão sem dias
    await importarBackup(p, { onboarded: true, guiaVisto: true, caixinhas: [5, { id: "a", nome: "Casa", cor: "#9C9BF5" }], limitesPadrao: { a: 500 },
      cartoes: [{ id: "k", nome: "Cartão" }], compras: [{ id: "c", cartao: "k", desc: "Fone", valorParcela: 50, parcelas: 2 }],
      meses: { [cur]: { gastos: [{ id: "g1", valor: 10, descricao: "Sem data", caixinha: "a", forma: "Pix" }], entradas: [null] } } });
    for (const t of ["inicio", "mes", "graficos", "cartao"]) await p.aba(t);
    await p.aba("mes");
    certo((await p.texto("#mesLista")).includes("Sem data"), "o gasto sem data devia continuar lá (com uma data segura): " + await p.texto("#mesLista"));
    await p.recarregar();
    igual(await p.texto("#inSobra"), "R$ 490,00", "o app abre depois do backup estragado");
    // 2) se mesmo assim o desenho falhar no meio, nada é trocado: os dados de antes ficam e a pessoa é avisada
    const antes = await guardado(p);
    await p.aba("ajustes/dados");
    await p.avaliar((txt) => { const i = document.querySelector("#impFile"), dt = new DataTransfer(); dt.items.add(new File([txt], "b.json")); i.files = dt.files; i.dispatchEvent(new Event("change", { bubbles: true })); },
      JSON.stringify({ caixinhas: [{ id: "z", nome: "Zebra", cor: "#9C9BF5" }], limitesPadrao: { z: 1 } }));
    certo(await p.ate(() => !!document.querySelector('#impConfirm [data-act="imp-ok"]')), "a importação devia pedir confirmação");
    // um desenho que falha uma vez (simula um defeito que a limpeza não previu)
    await p.avaliar(() => { const o = Date.prototype.toLocaleDateString; window.__quebrar = true; Date.prototype.toLocaleDateString = function (...a) { if (window.__quebrar) { window.__quebrar = false; throw new Error("desenho quebrado"); } return o.apply(this, a); }; });
    await p.clicar('[data-act="imp-ok"]'); await p.espera(300);
    igual(await p.avaliar(() => window.__quebrar), false, "o desenho devia ter falhado uma vez");
    certo((await p.texto("#impConfirm")).includes("Nada foi trocado"), "devia avisar que nada foi trocado: " + await p.texto("#impConfirm"));
    igual(canon(await guardado(p)), canon(antes), "os dados guardados continuam os de antes");
    await p.aba("inicio");
    certo(!(await p.texto("#inCx")).includes("Zebra"), "a tela continua com os dados de antes: " + await p.texto("#inCx"));
    await p.recarregar();
    igual(await p.texto("#inSobra"), "R$ 490,00", "e o app abre com eles");
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
    await escolherPastaPC(p, []);
    const arq = await arqHoje(p), ler = () => lerPC(p, [SUBPASTA], arq); // pasta vazia: o app grava na subpasta que criou
    certo((await ler() || "").includes("Cinema"), "o arquivo do dia não foi gravado na pasta");
    certo((await p.texto("#bkpBox")).includes("Gravando na pasta"), "o estado da pasta não apareceu");
    await p.clicar("#fab"); await p.digitar("#gValor", "20"); await p.digitar("#gDesc", "Pipoca"); await p.clicar("#gBtn");
    await p.espera(1900);
    certo((await ler() || "").includes("Pipoca"), "o arquivo não foi atualizado depois de um novo gasto");
    // arquivos antigos: sobram só os 7 mais recentes
    for (let i = 1; i <= 9; i++) await criarPC(p, [SUBPASTA], "caixinhas-backup-2020-01-0" + i + ".json", "{}");
    await p.clicar("#fab"); await p.digitar("#gValor", "5"); await p.digitar("#gDesc", "Bala"); await p.clicar("#gBtn");
    await p.espera(1900);
    igual((await pastaPC(p, [SUBPASTA])).filter((n) => n.startsWith("caixinhas-backup-")).length, 7, "arquivos de backup na pasta");
  },
  "Pasta do backup no PC: na pasta vazia o app cria “Orolon Caixinhas”, grava dentro e recria se for apagada": async (p) => {
    await p.aba("ajustes/dados");
    certo((await p.texto("#bkpBox")).includes("cria uma pasta “Orolon Caixinhas”"), "a ajuda de escolher a pasta conta da subpasta: " + await p.texto("#bkpBox"));
    for (const tema of ["noite", "dia"]) {
      await p.avaliar((tema) => { localStorage.setItem("caixinhas-orologia-tema", JSON.stringify({ atual: tema, meus: [] })); window.TemaCx.aplicar(window.TemaCx.porId(tema)); }, tema);
      for (const [w, h] of [[360, 780], [320, 640], [1280, 800]]) { await p.tamanho(w, h); await p.espera(150); await p.avaliar(() => document.querySelector("#bkpBox").scrollIntoView()); await p.print(`31-backup-escolher-${tema}-${w}`); }
    }
    await p.tamanho(360, 780);
    await escolherPastaPC(p, []);
    const arq = await arqHoje(p);
    igual(JSON.stringify(await pastaPC(p)), JSON.stringify([SUBPASTA + "/"]), "na pasta escolhida fica só a subpasta, nada solto");
    certo((await lerPC(p, [SUBPASTA], arq) || "").includes("Cinema"), "o arquivo do dia vai para dentro da subpasta");
    const gravando = "Gravando na pasta “escolhida/Orolon Caixinhas”"; // a pasta particular do navegador não tem nome: o app mostra "escolhida"
    certo((await p.texto("#bkpBox")).includes(gravando), "o nome mostrado indica a subpasta: " + await p.texto("#bkpBox"));
    await p.avaliar(() => document.querySelector("#bkpBox").scrollIntoView()); await p.espera(3600);
    for (const tema of ["dia", "noite"]) {
      await p.avaliar((tema) => { localStorage.setItem("caixinhas-orologia-tema", JSON.stringify({ atual: tema, meus: [] })); window.TemaCx.aplicar(window.TemaCx.porId(tema)); }, tema);
      for (const [w, h] of [[360, 780], [320, 640], [1280, 800]]) { await p.tamanho(w, h); await p.espera(150); await p.avaliar(() => document.querySelector("#bkpBox").scrollIntoView()); await p.print(`31-backup-gravando-${tema}-${w}`); }
    }
    await p.tamanho(360, 780);
    await p.recarregar(); await p.aba("ajustes/dados");
    certo((await p.texto("#bkpBox")).includes(gravando), "a subpasta continua depois de reabrir: " + await p.texto("#bkpBox"));
    // a pessoa apagou a subpasta: a próxima gravação cria de novo
    await p.avaliar(async (n) => (await navigator.storage.getDirectory()).removeEntry(n, { recursive: true }), SUBPASTA);
    await lancar(p, 20, "Pipoca"); await p.espera(1900);
    certo((await lerPC(p, [SUBPASTA], arq) || "").includes("Pipoca"), "a subpasta apagada volta na gravação seguinte");
    igual(JSON.stringify(await pastaPC(p)), JSON.stringify([SUBPASTA + "/"]), "nada solto na pasta escolhida depois de recriar");
  },
  "Pasta do backup no PC: a pasta que já se chama “Orolon Caixinhas” não ganha outra dentro": async (p) => {
    await escolherPastaPC(p, [SUBPASTA]);
    igual(JSON.stringify(await pastaPC(p, [SUBPASTA])), JSON.stringify([await arqHoje(p)]), "grava direto na pasta, sem aninhar");
    certo((await p.texto("#bkpBox")).includes("Gravando na pasta “Orolon Caixinhas”"), "nome mostrado sem repetir: " + await p.texto("#bkpBox"));
  },
  "Pasta do backup no PC: pasta com cópias soltas continua sendo usada como antes": async (p) => {
    await criarPC(p, [], "caixinhas-backup-2020-01-01.json", "{}");
    await escolherPastaPC(p, []);
    igual(JSON.stringify(await pastaPC(p)), JSON.stringify(["caixinhas-backup-2020-01-01.json", await arqHoje(p)].sort()), "grava ao lado das cópias, sem criar subpasta");
    certo((await p.texto("#bkpBox")).includes("Gravando na pasta “escolhida”"), "nome mostrado sem subpasta: " + await p.texto("#bkpBox"));
  },
  "Pasta do backup no PC: a subpasta que já existe é usada e a cópia do celular fica": async (p) => {
    const outro = "caixinhas-backup-2026-01-01-zzzz.json";
    await criarPC(p, [SUBPASTA], outro, "{}");
    await escolherPastaPC(p, []);
    igual(JSON.stringify(await pastaPC(p)), JSON.stringify([SUBPASTA + "/"]), "nada solto na pasta escolhida");
    igual(JSON.stringify(await pastaPC(p, [SUBPASTA])), JSON.stringify([await arqHoje(p), outro].sort()), "grava na subpasta que já existia e não apaga a cópia do outro aparelho");
  },
  "Pasta do backup no PC: se não der para criar a subpasta, grava na pasta escolhida sem erro": async (p) => {
    await criarPC(p, [], SUBPASTA, "não é pasta"); // um arquivo com o nome da subpasta: criar a pasta falha
    await escolherPastaPC(p, []);
    certo((await lerPC(p, [], await arqHoje(p)) || "").includes("Cinema"), "o arquivo do dia vai para a pasta escolhida");
    certo((await p.texto("#bkpBox")).includes("Gravando na pasta “escolhida”"), "nome mostrado sem subpasta: " + await p.texto("#bkpBox"));
  },
  "Pasta do backup no PC: a pasta escolhida antes desta versão continua recebendo os arquivos": async (p) => {
    await p.clicar('[data-act="onb-skip"]'); await lancar(p, 50, "Cinema");
    // como a 1.9 e a 2.0 de antes guardavam: só a pasta, sem o campo da subpasta
    await p.avaliar(async () => { const h = await navigator.storage.getDirectory(); await new Promise((ok, erro) => { const rq = indexedDB.open("caixinhas-orologia-copias", 1); rq.onerror = erro; rq.onsuccess = () => { const tx = rq.result.transaction("cfg", "readwrite"); tx.objectStore("cfg").put(h, "pasta"); tx.oncomplete = () => { rq.result.close(); ok(); }; tx.onerror = erro; }; }); });
    await p.recarregar(); await p.espera(1900);
    certo((await lerPC(p, [], await arqHoje(p)) || "").includes("Cinema"), "grava onde gravava");
    igual(await pastaPC(p, [SUBPASTA]), null, "sem subpasta para quem já tinha pasta");
    await p.aba("ajustes/dados");
    certo((await p.texto("#bkpBox")).includes("Gravando na pasta “escolhida”"), "nome mostrado sem subpasta: " + await p.texto("#bkpBox"));
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
    await p.avaliar(() => { location.reload(); }).catch(() => {});
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
    await p.avaliar(() => { location.reload(); }).catch(() => {});
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
    await p.avaliar(() => { location.reload(); }).catch(() => {});
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
      location.reload();
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
    await p.avaliar(() => { location.reload(); }).catch(() => {});
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
    await p.avaliar(() => { location.reload(); }).catch(() => {});
    await p.espera(900);
    igual(await p.abaAtual(), "mes", "o app reabre na aba Mês");
    igual(await p.avaliar(() => document.querySelector("#inResumo").dataset.abertura || ""), "", "a abertura longa não devia tocar fora do Início");
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
    await p.avaliar(() => history.back()); // o popstate chega depois: esperar a lista aparecer, sem tempo fixo
    certo(await p.ate(() => { const e = document.querySelector("#ajMenu"); return !!e && e.getBoundingClientRect().height > 0; }), "o voltar do aparelho fecha a parte e mostra a lista");
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
  // A escolha da subpasta no Android é do plugin (Java, só o aparelho prova). Aqui: o app passa a subpasta que o plugin devolve
  // em toda conta com a pasta, mostra o nome que ele dá e guarda a subpasta nova quando o plugin recria uma apagada.
  "Android: a subpasta que o plugin devolve vale para conferir, gravar e listar": { nativo: true, fn: async (p) => {
    const outro = "caixinhas-backup-2026-01-01-zzzz.json";
    await p.avaliar((outro) => {
      const d = new Date(), mes = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
      localStorage.setItem("caixinhas-orologia-v1", JSON.stringify({ onboarded: true, guiaVisto: true, caixinhas: [{ id: "a", nome: "Tudo", cor: "#9C9BF5" }], limitesPadrao: { a: 500 },
        meses: { [mes]: { gastos: [{ id: "g1", valor: 30, descricao: "Pão", caixinha: "a", forma: "Pix", data: mes + "-01" }] } } }));
      localStorage.setItem("__escolha", JSON.stringify({ uri: "content://arvore", nome: "Backups/Orolon Caixinhas", sub: "doc-sub" }));
      localStorage.setItem("__pasta", JSON.stringify({ [outro]: "{}" })); // a subpasta que já existia tem a cópia de outro celular
    }, outro);
    await p.recarregar(); await p.aba("ajustes/dados");
    const ult = (qual) => p.avaliar((qual) => (window.__nativo.chamadas.filter((x) => x[0] === qual).pop() || [])[1] || null, qual);
    const gravacoes = () => p.avaliar(() => window.__nativo.chamadas.filter((x) => x[0] === "gravarBackup").length);
    await p.clicar('[data-act="bkp-pasta"]'); await p.espera(300);
    igual(JSON.stringify(await ult("listarBackups")), JSON.stringify({ uri: "content://arvore", sub: "doc-sub" }), "a conferência de cópias olha dentro da subpasta");
    certo((await p.texto("#bkpBox")).includes("A pasta “Backups/Orolon Caixinhas” já tem uma cópia"), "pergunta antes de gravar na subpasta com cópia: " + await p.texto("#bkpBox"));
    igual(await gravacoes(), 0, "nada é gravado antes da resposta");
    await p.clicar('[data-act="bkp-usar"]'); await p.espera(400);
    const g = await ult("gravarBackup");
    igual(g.uri + "|" + g.sub, "content://arvore|doc-sub", "a gravação vai para a subpasta");
    certo(await p.avaliar((outro) => outro in JSON.parse(localStorage.getItem("__pasta")), outro), "a cópia do outro aparelho foi apagada");
    certo((await p.texto("#bkpBox")).includes("Gravando na pasta “Backups/Orolon Caixinhas”"), "nome que o plugin deu: " + await p.texto("#bkpBox"));
    // a pessoa apagou a subpasta e o plugin criou outra ao gravar: o app guarda a nova para as próximas vezes
    await p.avaliar(() => localStorage.setItem("__devolve", JSON.stringify({ sub: "doc-sub-2" })));
    await lancar(p, 12, "Café"); await p.espera(1900);
    await p.avaliar(() => localStorage.removeItem("__devolve"));
    await p.recarregar(); await p.espera(1900);
    igual((await ult("gravarBackup") || {}).sub, "doc-sub-2", "depois de reabrir, grava na subpasta recriada");
    await p.aba("ajustes/dados");
    certo((await p.texto("#bkpBox")).includes("Gravando na pasta “Backups/Orolon Caixinhas”"), "o nome continua: " + await p.texto("#bkpBox"));
    await p.clicar('[data-act="bkp-ver"]'); await p.espera(300);
    igual((await ult("listarBackups") || {}).sub, "doc-sub-2", "ver cópias da pasta olha a subpasta");
  } },
  "Android: a pasta escolhida antes desta versão (sem subpasta) continua igual": { nativo: true, fn: async (p) => {
    await p.avaliar(() => {
      const d = new Date(), mes = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
      localStorage.setItem("caixinhas-orologia-v1", JSON.stringify({ onboarded: true, guiaVisto: true, caixinhas: [{ id: "a", nome: "Tudo", cor: "#9C9BF5" }], limitesPadrao: { a: 500 },
        meses: { [mes]: { gastos: [{ id: "g1", valor: 30, descricao: "Pão", caixinha: "a", forma: "Pix", data: mes + "-01" }] } } }));
      localStorage.setItem("caixinhas-orologia-pasta", JSON.stringify({ uri: "content://pasta-de-teste", nome: "Backup" }));
    });
    await p.recarregar(); await p.espera(1900);
    const g = await p.avaliar(() => (window.__nativo.chamadas.filter((x) => x[0] === "gravarBackup").pop() || [])[1] || null);
    certo(g, "devia gravar na pasta guardada");
    igual(JSON.stringify([g.uri, "sub" in g ? g.sub : "sem"]), JSON.stringify(["content://pasta-de-teste", "sem"]), "grava na pasta de sempre, sem subpasta");
    igual(await p.avaliar(() => localStorage.getItem("caixinhas-orologia-pasta")), JSON.stringify({ uri: "content://pasta-de-teste", nome: "Backup" }), "o que estava guardado não muda");
    await p.aba("ajustes/dados");
    certo((await p.texto("#bkpBox")).includes("Gravando na pasta “Backup”"), "nome de sempre: " + await p.texto("#bkpBox"));
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
  "Android: salvar manda a sobra ao widget; com PIN não manda valores": { nativo: true, fn: async (p) => {
    await comExemplo(p);
    const widgets = () => p.avaliar(() => window.__nativo.chamadas.filter((x) => x[0] === "widget").map((x) => x[1]));
    const hoje = new Date(), mes = hoje.getFullYear() + "-" + String(hoje.getMonth() + 1).padStart(2, "0");
    const ultimo = new Date(hoje.getFullYear(), hoje.getMonth() + 1, 0).getDate();
    await p.aba("inicio"); await lancar(p, 12.5, "Café"); await p.espera(200);
    let w = (await widgets()).pop();
    certo(w, "lançar um gasto devia mandar os valores ao widget");
    igual(w.mes, mes, "mês mandado ao widget"); igual(w.ultimoDia, ultimo, "último dia do mês"); igual(w.mostrar, true, "sem PIN o widget mostra os valores");
    certo(typeof w.sobra === "string" && /^-?\d+(\.\d+)?$/.test(w.sobra), "sobra em texto com ponto: " + JSON.stringify(w.sobra));
    const naTela = (await p.texto("#inSobra")).replace(/\s/g, " ");
    igual(new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(Number(w.sobra)).replace(/\s/g, " "), naTela, "a sobra do widget é a do Início");
    // ligar o PIN tira os valores do widget na hora, e nenhum salvamento depois volta a mandá-los
    await p.aba("ajustes/pin"); await p.digitar("#pinNovo", "1234"); await p.digitar("#pinRep", "1234"); await p.clicar('[data-pin="ativar"]'); await p.espera(400);
    let ws = await widgets(); w = ws.pop();
    certo(w && w.mostrar === false && w.sobra === "" && w.mes === mes, "ao ligar o PIN o widget devia ficar só com o botão: " + JSON.stringify(w));
    const antes = (await widgets()).length;
    await lancar(p, 3, "Bala"); await p.espera(200);
    ws = (await widgets()).slice(antes);
    certo(ws.length >= 1, "salvar com PIN também avisa o widget");
    certo(ws.every((x) => x.mostrar === false && x.sobra === ""), "com PIN nenhum valor vai ao widget: " + JSON.stringify(ws));
    // desligar o PIN devolve os valores
    await p.aba("ajustes/pin"); await p.digitar("#pinAtual", "1234"); await p.clicar('[data-pin="desativar"]'); await p.espera(400);
    w = (await widgets()).pop();
    certo(w && w.mostrar === true && w.sobra !== "", "sem o PIN os valores voltam ao widget: " + JSON.stringify(w));
  } },
  "Android: abrir pelo widget cai na folha de lançar; com PIN, só depois do código": { nativo: true, fn: async (p) => {
    await comExemplo(p);
    const folha = () => p.avaliar(() => !document.querySelector("#folhaGasto").hidden);
    const url = (u) => p.avaliar((u) => window.__nativo.urlAberta({ url: u }), u).then(() => p.espera(300));
    const voltar = async () => { await p.avaliar(() => { window.__nativo.voltar(); }); await p.espera(350); };
    // o app abre de novo do zero (não é um recarregar): o Android cria a tela outra vez
    const abrirDoZero = async () => { await p.avaliar(() => { sessionStorage.clear(); location.href = "/index.html?aberto=" + Date.now(); }).catch(() => {}); await p.espera(1000); };
    // com o app aberto
    await p.aba("mes");
    await url("caixinhas://outra");
    igual(await folha(), false, "outro endereço não abre a folha");
    await url("caixinhas://lancar");
    igual(await folha(), true, "com o app aberto, tocar no widget abre a folha de lançar");
    igual(await p.abaAtual(), "mes", "a folha abre por cima da tela em que o app estava");
    await voltar();
    igual(await folha(), false, "voltar fecha a folha");
    // com o app fechado
    await p.avaliar(() => localStorage.setItem("__launch", JSON.stringify("caixinhas://lancar")));
    await abrirDoZero();
    igual(await folha(), true, "abrindo o app pelo widget, a folha de lançar aparece");
    await voltar(); await p.espera(300);
    igual(await folha(), false, "um voltar fecha a folha (ela abriu uma vez só)");
    await p.recarregar();
    igual(await folha(), false, "o endereço vale uma vez: recarregar não abre a folha de novo");
    await p.avaliar(() => localStorage.removeItem("__launch"));
    await abrirDoZero();
    igual(await folha(), false, "abrir pelo ícone do app não abre a folha");
    // com PIN: primeiro o código, depois a folha
    await p.aba("ajustes/pin"); await p.digitar("#pinNovo", "1234"); await p.digitar("#pinRep", "1234"); await p.clicar('[data-pin="ativar"]'); await p.espera(400);
    await p.avaliar(() => localStorage.setItem("__launch", JSON.stringify("caixinhas://lancar")));
    await abrirDoZero();
    certo(await p.visivel("#trava"), "com PIN, o app abre pedindo o código");
    igual(await folha(), false, "a folha não abre antes do código");
    for (const d of "1234") await p.clicar(`#trava [data-tk="${d}"]`);
    await p.espera(600);
    igual(await p.visivel("#trava"), false, "o código certo destrava");
    igual(await folha(), true, "depois do código, a folha de lançar abre");
    await p.print("27-widget-folha-depois-do-pin");
    await voltar();
    // app aberto, mas travado
    await p.avaliar(() => localStorage.removeItem("__launch"));
    await p.aba("ajustes/pin"); await p.clicar('[data-pin="agora"]');
    await url("caixinhas://lancar");
    igual(await folha(), false, "com o app travado, o toque no widget espera o código");
    for (const d of "1234") await p.clicar(`#trava [data-tk="${d}"]`);
    await p.espera(600);
    igual(await folha(), true, "destravado, a folha abre");
  } },
  "Android: o toque no widget vale uma vez também ao voltar da política de privacidade": { nativo: true, fn: async (p) => {
    await comExemplo(p);
    const folha = () => p.avaliar(() => !document.querySelector("#folhaGasto").hidden);
    const pronta = () => p.ate(() => document.readyState === "complete" && !!window.TemaCx && !window.__velha);
    await p.avaliar(() => { localStorage.setItem("__launch", JSON.stringify("caixinhas://lancar")); sessionStorage.clear(); location.href = "/index.html?aberto=" + Date.now(); }).catch(() => {});
    await p.espera(1000); await pronta();
    igual(await folha(), true, "aberto pelo widget, a folha aparece");
    await p.avaliar(() => window.__nativo.voltar()); await p.espera(350);
    igual(await folha(), false, "voltar fecha a folha");
    // a política abre dentro do app; voltar dela carrega o index.html de novo, e o Capacitor devolve o mesmo endereço de abertura
    await p.avaliar(() => { window.__velha = true; location.href = "/privacy.html"; }).catch(() => {}); await p.espera(800);
    await p.avaliar(() => history.back()).catch(() => {}); await p.espera(1000); await pronta();
    igual(await folha(), false, "ao voltar da política a folha não abre de novo");
    // o mesmo para uma página carregada de novo de outro jeito, ainda na mesma abertura do app
    await p.avaliar(() => { window.__velha = true; location.href = "/index.html?de-novo=" + Date.now(); }).catch(() => {}); await p.espera(1000); await pronta();
    igual(await folha(), false, "carregar a página de novo na mesma abertura do app não abre a folha");
  } },
  "Android: o PIN que trava com a folha aberta só tira o foco; depois do código a folha está como estava (edição, gasto novo, widget)": { nativo: true, fn: async (p) => {
    await comExemplo(p);
    const folha = () => p.avaliar(() => !document.querySelector("#folhaGasto").hidden);
    const focoNaFolha = () => p.avaliar(() => !!document.activeElement && !!document.activeElement.closest("#folhaGasto"));
    // trava e devolve se algum campo da folha ainda tinha o foco logo depois, antes de a tela se redesenhar
    // (o Chrome tira sozinho o foco de campo escondido só no redesenho seguinte; até lá o teclado ainda digitaria nele)
    let focoNaHora = null;
    const travarAgora = () => p.avaliar(() => { document.querySelector('[data-pin="agora"]').click(); const a = document.activeElement; return !!a && !!a.closest("#folhaGasto"); }).then(async (f) => { focoNaHora = f; await p.espera(300); });
    const codigo = async () => { for (const d of "1234") await p.clicar(`#trava [data-tk="${d}"]`); await p.espera(600); };
    await p.aba("ajustes/pin"); await p.digitar("#pinNovo", "1234"); await p.digitar("#pinRep", "1234"); await p.clicar('[data-pin="ativar"]'); await p.espera(400);
    // 1) edição de um gasto, com o valor mudado e ainda não salvo
    await p.aba("mes");
    const id = await p.avaliar(() => [...document.querySelectorAll("#mesLista .n-lanc")].find((b) => b.textContent.includes("Uber")).dataset.id);
    const guardado = () => p.avaliar((id) => { for (const m of Object.values(JSON.parse(localStorage.getItem("caixinhas-orologia-v1")).meses)) for (const g of m.gastos || []) if (g.id === id) return g.valor; return null; }, id);
    await p.clicar('.n-lanc[data-id="' + id + '"]');
    igual(await p.texto("#gHead"), "Editar gasto", "a folha abriu em edição");
    await p.digitar("#gValor", "77,7"); await p.avaliar(() => document.querySelector("#gValor").focus());
    await travarAgora();
    certo(await p.visivel("#trava"), "o PIN travou o app");
    igual(focoNaHora, false, "com o app travado, nenhum campo da folha fica com o foco (o teclado não digita por trás da trava) (na hora da trava)"); igual(await focoNaFolha(), false, "com o app travado, nenhum campo da folha fica com o foco (o teclado não digita por trás da trava)");
    await codigo();
    igual(await folha(), true, "depois do código a folha continua aberta");
    igual(await p.texto("#gHead"), "Editar gasto", "e continua em edição");
    igual(await p.avaliar(() => document.querySelector("#gValor").value), "77,7", "com o valor que a pessoa tinha mudado");
    igual(await guardado(), 18.5, "o gasto guardado não mudou (nada foi salvo nem desfeito)");
    await p.clicar('.folha-topo [data-act="folha-fechar"]');
    // 2) gasto novo com valor e descrição digitados
    await p.clicar("#fab"); await p.digitar("#gValor", "12,34"); await p.digitar("#gDesc", "Pão de queijo");
    await p.avaliar(() => document.querySelector("#gDesc").focus());
    await travarAgora();
    igual(focoNaHora, false, "travado com a folha nova aberta: sem foco nela (na hora da trava)"); igual(await focoNaFolha(), false, "travado com a folha nova aberta: sem foco nela");
    await codigo();
    igual(await p.texto("#gHead"), "Lançar gasto", "a folha nova continua nova");
    igual(await p.avaliar(() => [document.querySelector("#gValor").value, document.querySelector("#gDesc").value].join("|")), "12,34|Pão de queijo", "o que foi digitado continua lá");
    await p.clicar('.folha-topo [data-act="folha-fechar"]');
    // 3) folha aberta pelo widget um instante antes de travar: continua lá depois do código
    await p.avaliar(() => window.__nativo.urlAberta({ url: "caixinhas://lancar" })); await p.espera(300);
    igual(await folha(), true, "a folha abriu pelo widget");
    await p.avaliar(() => document.querySelector("#gValor").focus());
    await travarAgora();
    igual(focoNaHora, false, "travado com a folha do widget: sem foco nela (na hora da trava)"); igual(await focoNaFolha(), false, "travado com a folha do widget: sem foco nela");
    await codigo();
    igual(await folha(), true, "depois do código, a folha aberta pelo widget continua ali");
    await p.clicar('.folha-topo [data-act="folha-fechar"]');
    // 4) o toque no widget com o app já travado: a folha só abre depois do código
    await travarAgora();
    await p.avaliar(() => window.__nativo.urlAberta({ url: "caixinhas://lancar" })); await p.espera(300);
    igual(await folha(), false, "travado, o toque no widget espera o código");
    await codigo();
    igual(await folha(), true, "depois do código, a folha abre");
  } },
  "Android: os ícones da barra de status seguem o tema (claros no escuro, escuros no claro), desde a abertura": { nativo: true, fn: async (p) => {
    // estilo do plugin SystemBars do Capacitor: "DARK" = ícones claros (para fundo escuro); "LIGHT" = ícones escuros (para fundo claro)
    const ultimo = () => p.avaliar(() => { const b = window.__nativo.barras; return b.length ? b[b.length - 1].style : null; });
    await comExemplo(p);
    igual(await ultimo(), "DARK", "no tema de fábrica (Orologia Noite), ícones claros");
    await p.aba("ajustes/aparencia");
    for (const [id, estilo] of [["dia", "LIGHT"], ["g-ametista", "DARK"], ["g-folha", "LIGHT"], ["g-papel", "LIGHT"], ["g-areia", "LIGHT"], ["g-nevoa", "LIGHT"], ["g-lirio", "LIGHT"], ["noite", "DARK"]]) {
      await p.clicar('#temaBox [data-tm="usar"][data-id="' + id + '"]');
      igual(await ultimo(), estilo, "estilo da barra no tema " + id);
    }
    certo(await p.avaliar(() => window.__nativo.barras.every((b) => !b.bar)), "o estilo vale para as duas barras (status e navegação)");
    // editor de tema: o rascunho manda enquanto é mexido; cancelar volta ao do tema ativo
    await p.clicar('#temaBox [data-tm="criar"]');
    await p.avaliar(() => { const i = document.querySelector("#tm-fundo"); i.value = "#f4f1ea"; i.dispatchEvent(new Event("input", { bubbles: true })); });
    igual(await ultimo(), "LIGHT", "rascunho com fundo claro: ícones escuros enquanto mexe");
    await p.clicar('[data-tm="cancelar"]');
    igual(await ultimo(), "DARK", "cancelar volta ao estilo do tema ativo");
    // na abertura: com um tema claro guardado, o primeiro pedido já é o certo, antes de a página aparecer
    await p.avaliar(() => localStorage.setItem("caixinhas-orologia-tema", JSON.stringify({ atual: "g-lirio", meus: [] })));
    await p.recarregar();
    const ab = await p.avaliar(() => window.__nativo.barras);
    certo(ab.length >= 1 && ab[0].style === "LIGHT" && !ab[0].corpo, "na abertura o primeiro estilo é o do tema claro, pedido antes do corpo da página: " + JSON.stringify(ab));
    certo(ab.every((b) => b.style === "LIGHT"), "nada pede ícones claros na abertura de um tema claro: " + JSON.stringify(ab));
    // um app sem o plugin (versão antiga) abre igual
    await p.injetar("if (window.Capacitor && window.Capacitor.Plugins) delete window.Capacitor.Plugins.SystemBars;"); // roda depois do Capacitor de mentira
    await p.recarregar(); await p.aba("inicio");
    certo(await p.visivel("#inSobra"), "sem o plugin de barras o app abre normalmente");
  } },
  "No site o app não pede estilo de barra ao sistema": async (p) => {
    // um Capacitor de mentira que diz não ser o app: nada pode ser pedido a ele
    await p.injetar("window.__barras = []; window.Capacitor = { isNativePlatform: () => false, Plugins: { SystemBars: { setStyle: async (o) => { window.__barras.push(o); } } } };");
    await p.recarregar();
    await comExemplo(p);
    await p.aba("ajustes/aparencia");
    await p.clicar('#temaBox [data-tm="usar"][data-id="dia"]');
    igual(await p.avaliar(() => window.__barras.length), 0, "no site nenhum estilo de barra é pedido");
  },
  // Em WebView anterior à 140 a página não passa por trás da barra: a faixa mostra o fundo da janela nativa, que segue o modo
  // claro/escuro do sistema. Aí o app pede "DEFAULT" (o plugin escolhe os ícones pelo modo do sistema), não o estilo do tema.
  "Android: em WebView anterior à 140 a barra segue o modo do sistema, não o tema": { nativo: true, fn: async (p) => {
    const ua = (v) => `Object.defineProperty(navigator, "userAgent", { configurable: true, get: () => "Mozilla/5.0 (Linux; Android 10; K; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 ${v} Mobile Safari/537.36" });`;
    const estilos = () => p.avaliar(() => window.__nativo.barras.map((b) => b.style));
    const ultimo = async () => (await estilos()).pop() || null;
    await p.injetar(ua("Chrome/130.0.6723.107")); await p.recarregar();
    await comExemplo(p);
    igual(await ultimo(), "DEFAULT", "tema escuro numa WebView 130");
    await p.aba("ajustes/aparencia");
    for (const id of ["dia", "g-lirio", "noite"]) { await p.clicar('#temaBox [data-tm="usar"][data-id="' + id + '"]'); igual(await ultimo(), "DEFAULT", "tema " + id + " numa WebView 130"); }
    certo((await estilos()).every((s) => s === "DEFAULT"), "nada pede LIGHT/DARK numa WebView 130: " + JSON.stringify(await estilos()));
    // 140 ou mais: o estilo segue o tema, como antes
    await p.avaliar(() => localStorage.setItem("caixinhas-orologia-tema", JSON.stringify({ atual: "g-lirio", meus: [] })));
    await p.injetar(ua("Chrome/140.0.7339.51")); await p.recarregar();
    igual(await ultimo(), "LIGHT", "tema claro numa WebView 140");
    // versão ilegível: fica como antes (segue o tema)
    await p.injetar(ua("Navegador/1")); await p.recarregar();
    igual(await ultimo(), "LIGHT", "tema claro sem versão legível");
  } },
  "Fundo de reserva sem color-mix na folha de lançar e no aviso": async (p) => {
    // navegador sem color-mix descarta a declaração inteira: a regra de base precisa de um fundo simples antes
    const r = await p.avaliar(() => {
      const achou = {};
      for (const f of document.styleSheets) for (const regra of f.cssRules) {
        if (!regra.style || (regra.selectorText !== ".folha-caixa" && regra.selectorText !== ".toast")) continue;
        const v = regra.style.getPropertyValue("background") || regra.style.getPropertyValue("background-color");
        if (v && !v.includes("color-mix")) achou[regra.selectorText] = v.trim();
      }
      return achou;
    });
    igual(r[".folha-caixa"], "var(--surface)", "fundo simples da folha de lançar");
    igual(r[".toast"], "var(--surface2)", "fundo simples do aviso");
  },
  "Gastos fixos: a linha mostra o dia, a caixinha e a forma separados": async (p) => {
    await semearContas(p); await p.recarregar();
    const sub = await p.avaliar(() => { const i = [...document.querySelectorAll("#fixosLista .item")].find((x) => x.textContent.includes("Internet")); return i ? i.querySelector(".sub").textContent : null; });
    certo(/^todo dia \d+ · Contas · Pix$/.test(sub || ""), "texto da linha do fixo: " + JSON.stringify(sub));
  },
  "Android: o botão de apoio pelo GitHub não aparece no app": { nativo: true, fn: async (p) => {
    await comExemplo(p);
    // links de apoio (a tela Apoie e o GitHub Sponsors) que aparecem na tela
    const apoioVisivel = () => p.avaliar(() => [...document.querySelectorAll('a[href="#apoie"], a[href*="github.com/sponsors"]')].filter((a) => { const r = a.getBoundingClientRect(); return r.width > 0 && r.height > 0; }).length);
    const textoDe = (sel) => p.avaliar((q) => document.querySelector(q).parentElement.innerText.replace(/\s+/g, " ").trim(), sel);
    igual(await apoioVisivel(), 0, "no Início do app não há link de apoio");
    igual(await textoDe('#v-inicio a[href="#ajustes"]'), "Temas e ajustes", "o rodapé do Início fica só com os ajustes, sem separador sobrando");
    await p.aba("ajustes");
    igual(await p.avaliar(() => document.querySelector('#ajMenu [data-parte="sobre"] small').innerText.trim()), "Versão e privacidade", "a lista dos Ajustes não promete apoio no app");
    await p.aba("ajustes/sobre");
    igual(await apoioVisivel(), 0, "no Sobre do app não há link de apoio");
    igual(await textoDe('[data-parte="sobre"] a[href="privacy.html"]'), "Política de privacidade", "o Sobre fica só com a política, sem separador sobrando");
    await p.aba("apoie");
    igual(await p.abaAtual(), "inicio", "a tela Apoie não abre dentro do app");
    igual(await apoioVisivel(), 0, "nenhum botão Apoiar no GitHub no app");
    for (const tema of ["noite", "dia"]) {
      await p.avaliar((tema) => localStorage.setItem("caixinhas-orologia-tema", JSON.stringify({ atual: tema, meus: [] })), tema);
      for (const [w, h] of [[360, 780], [320, 640], [1280, 800]]) {
        await p.tamanho(w, h); await p.recarregar(); await p.aba("ajustes/sobre");
        await p.print(`28-sobre-android-${tema}-${w}`);
        await p.aba("inicio"); await p.avaliar(() => window.scrollTo(0, document.body.scrollHeight)); await p.espera(150);
        await p.print(`28-inicio-fim-android-${tema}-${w}`);
      }
    }
  } },
  "No site nada de widget": async (p) => {
    // um Capacitor que não é o app (isNativePlatform falso): o site não pode chamar o widget nem abrir a folha pelo endereço
    await p.injetar(`(${() => {
      window.__site = { widget: 0 };
      window.Capacitor = { isNativePlatform: () => false, Plugins: {
        Caixinhas: { widget: async () => { window.__site.widget++; } },
        App: { getLaunchUrl: async () => ({ url: "caixinhas://lancar" }), addListener: (ev, fn) => { if (ev === "appUrlOpen") setTimeout(() => fn({ url: "caixinhas://lancar" }), 0); return Promise.resolve({ remove() {} }); } },
      } };
    }})()`);
    await p.avaliar(() => { location.href = "/index.html?site=" + Date.now(); }).catch(() => {}); await p.espera(1000);
    await comExemplo(p);
    igual(await p.avaliar(() => !document.querySelector("#folhaGasto").hidden), false, "no site o endereço do widget não abre a folha");
    await lancar(p, 5, "Pão"); await p.espera(300);
    igual(await p.avaliar(() => window.__site.widget), 0, "no site nada é mandado ao widget");
    // o apoio pelo GitHub continua no site
    certo(await p.visivel('#v-inicio a[href="#apoie"]'), "no site o Início tem o link Apoie o projeto");
    await p.aba("ajustes/sobre");
    certo(await p.visivel('[data-parte="sobre"] a[href="#apoie"]'), "no site o Sobre tem o link Apoie o projeto");
    await p.aba("apoie");
    igual(await p.abaAtual(), "apoie", "no site a tela Apoie abre");
    certo(await p.visivel('#v-apoie a[href*="github.com/sponsors"]'), "no site aparece o botão Apoiar no GitHub");
  },
  "Android: o script monta tela de ponta a ponta, widget, ícone e sufixo de teste no projeto gerado": async () => {
    const cfg = JSON.parse(readFileSync(join(RAIZ, "capacitor.config.json"), "utf8"));
    // barras do sistema como no Player 1.26.6 (conferido no celular do Jo-ah): recuo pelo Android, EdgeToEdge depois do super.onCreate
    igual(cfg.plugins.SystemBars.insetsHandling, "native", "barras do sistema pelo Android, como no Player 1.26.6");
    igual(cfg.plugins.LocalNotifications.smallIcon, "ic_notif", "ícone próprio da notificação");
    const rodar = (pasta, loja) => spawnSync(process.execPath, [join(RAIZ, "scripts", "plugin-android.mjs")], { cwd: pasta, encoding: "utf8", env: Object.assign({}, process.env, { CX_LOJA: loja ? "1" : "", CX_COM_INTERNET: "" }) });
    // projeto que o script não sabe ajustar: tem de parar com erro, não seguir em silêncio
    {
      const pasta = await mkdtemp(join(tmpdir(), "caixinhas-android-"));
      try {
        const proj = await projetoAndroidFalso(pasta), nomes = join(proj, "src/main/res/values/strings.xml");
        await writeFile(nomes, readFileSync(nomes, "utf8").replace('<string name="app_name">', '<string name="app_name" translatable="false">'));
        const r = rodar(pasta, false);
        certo(r.status !== 0 && /teste/.test(r.stderr || ""), "sem conseguir pôr o (teste) no nome, o script devia falhar: " + r.status + " " + (r.stderr || "").trim());
      } finally { await rm(pasta, { recursive: true, force: true }); }
    }
    // manifesto que já tem outro tools:node="remove": a retirada da INTERNET entra mesmo assim
    {
      const pasta = await mkdtemp(join(tmpdir(), "caixinhas-android-"));
      try {
        const proj = await projetoAndroidFalso(pasta), arq = join(proj, "src/main/AndroidManifest.xml");
        await writeFile(arq, readFileSync(arq, "utf8").replace("<manifest ", '<manifest xmlns:tools="http://schemas.android.com/tools" ').replace("</application>", '    <meta-data android:name="outra.coisa" tools:node="remove" />\n    </application>'));
        igual(rodar(pasta, false).status, 0, "o script terminou bem");
        certo(/<uses-permission android:name="android\.permission\.INTERNET" tools:node="remove" \/>/.test(readFileSync(arq, "utf8")), "a retirada da INTERNET entra mesmo com outro tools:node=\"remove\" no manifesto");
      } finally { await rm(pasta, { recursive: true, force: true }); }
    }
    for (const loja of [false, true]) {
      const pasta = await mkdtemp(join(tmpdir(), "caixinhas-android-"));
      try {
        const proj = await projetoAndroidFalso(pasta);
        const r = rodar(pasta, loja);
        igual(r.status, 0, "o script terminou bem (" + (r.stderr || "").trim() + ")");
        const ler = (f) => readFileSync(join(proj, f), "utf8");
        const java = "src/main/java/com/joah/caixinhas/";
        // MainActivity: plugin registrado antes de o Capacitor iniciar; de ponta a ponta só DEPOIS do super.onCreate
        // (antes, a janela nasce com o tema da abertura e a imagem dela vira uma faixa no topo: o defeito visto no Player 1.26.5)
        const main = ler(java + "MainActivity.java");
        certo(main.startsWith("package com.joah.caixinhas;"), "MainActivity com o pacote do app");
        certo(main.includes("import androidx.activity.EdgeToEdge;"), "MainActivity importa o EdgeToEdge");
        const iP = main.indexOf("registerPlugin(CaixinhasPlugin.class);"), iS = main.indexOf("super.onCreate(savedInstanceState);"), iE = main.indexOf("EdgeToEdge.enable(this);");
        certo(iP > 0 && iP < iS, "plugin registrado antes do super.onCreate");
        certo(iE > iS && iS > 0, "EdgeToEdge.enable(this) só depois do super.onCreate (antes, a abertura vira uma faixa no topo)");
        certo(main.includes("FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY") && main.indexOf("setData(null)") < iS, "o endereço do widget sai antes do super.onCreate quando a tela é recriada");
        for (const f of ["CaixinhasPlugin.java", "LancarWidget.java"]) {
          const t = ler(java + f);
          certo(t.startsWith("package com.joah.caixinhas;") && !t.includes("package PACOTE"), f + " copiado com o pacote do app");
        }
        // manifesto: o widget registrado dentro do <application>, sem internet e sem permissão nova
        const xml = ler("src/main/AndroidManifest.xml");
        const rec = (xml.match(/<receiver[^>]*android:name="\.LancarWidget"[\s\S]*?<\/receiver>/) || [""])[0];
        certo(rec, "receiver do widget no manifesto");
        certo(/android:exported="false"/.test(rec) && rec.includes('"android.appwidget.action.APPWIDGET_UPDATE"') && rec.includes('android:name="android.appwidget.provider"') && rec.includes('android:resource="@xml/widget_lancar"'), "receiver do widget completo: " + rec);
        certo(xml.indexOf(rec) > xml.indexOf("<application") && xml.indexOf(rec) < xml.indexOf("</application>"), "o receiver fica dentro do <application>");
        const perms = xml.match(/<uses-permission[^>]*>/g) || [];
        certo(perms.length === 1 && perms[0].includes("android.permission.INTERNET") && perms[0].includes('tools:node="remove"'), "nenhuma permissão nova, e a de internet sai: " + perms.join(" "));
        // recursos copiados, e tudo o que eles e o Java citam existe (o PC não compila: aqui se pega o nome errado)
        const res = join(proj, "src/main/res");
        for (const f of ["layout/widget_lancar.xml", "xml/widget_lancar.xml", "drawable/ic_notif.xml"]) certo(existsSync(join(res, f)), "recurso copiado: " + f);
        const nomesDe = (tipo) => { const d = join(res, tipo); return existsSync(d) ? readdirSync(d).map((f) => f.replace(/\.xml$/, "")) : []; };
        const valores = readdirSync(join(res, "values")).map((f) => readFileSync(join(res, "values", f), "utf8")).join("\n");
        const existe = (tipo, nome) => tipo === "string" || tipo === "color" || tipo === "dimen" ? new RegExp(`<${tipo} name="${nome}"`).test(valores) : nomesDe(tipo).includes(nome);
        const meus = ["layout/widget_lancar.xml", "xml/widget_lancar.xml"].concat(readdirSync(join(RAIZ, "android-assets", "res", "drawable")).map((f) => "drawable/" + f)).map((f) => readFileSync(join(res, f), "utf8")).join("\n") + rec;
        for (const [, tipo, nome] of meus.matchAll(/@(drawable|layout|xml|string|color|dimen)\/(\w+)/g)) certo(existe(tipo, nome), `@${tipo}/${nome} citado mas não existe`);
        const ids = [...ler("src/main/res/layout/widget_lancar.xml").matchAll(/android:id="@\+id\/(\w+)"/g)].map((m) => m[1]);
        const widget = ler(java + "LancarWidget.java");
        for (const [, tipo, nome] of widget.matchAll(/\bR\.(id|layout|drawable|string)\.(\w+)/g)) certo(tipo === "id" ? ids.includes(nome) : existe(tipo, nome), `R.${tipo}.${nome} citado no Java mas não existe`);
        // APK de teste ao lado do da loja: sufixo no identificador e "(teste)" no nome; o da loja fica como está
        const gradle = ler("build.gradle"), nomes = ler("src/main/res/values/strings.xml");
        if (loja) {
          certo(!gradle.includes("applicationIdSuffix"), "o pacote da loja não ganha sufixo");
          certo(nomes.includes('<string name="app_name">Orolon Caixinhas</string>') && !nomes.includes("(teste)"), "o pacote da loja mantém o nome");
        } else {
          certo(/defaultConfig\s*\{[^}]*applicationIdSuffix "\.teste"/.test(gradle), "o APK de teste ganha o sufixo .teste: " + gradle.slice(0, 600));
          certo(nomes.includes('<string name="app_name">Orolon Caixinhas (teste)</string>') && nomes.includes('<string name="title_activity_main">Orolon Caixinhas (teste)</string>'), "o APK de teste se chama Orolon Caixinhas (teste)");
        }
      } finally { await rm(pasta, { recursive: true, force: true }); }
    }
  },
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
    // "Automático" tira o brilho escolhido: o clarão volta a seguir o destaque e o tema é salvo sem o campo
    await p.clicar('[data-tm="criar"]');
    await p.digitar("#tm-brilho", "#ff2200");
    igual(await varCss(p, "--glow"), "#FF2200", "brilho escolhido no tema novo");
    await p.avaliar(() => document.querySelector("#tm-brilho").scrollIntoView({ block: "center" })); await p.print("24-editor-tema-360");
    await p.clicar('[data-tm="brilho-auto"]');
    igual(await varCss(p, "--glow"), misturar("#6FB7FF", "#101820", 0.35), "Automático: o clarão volta a seguir o destaque");
    await p.digitar("#tmNome", "Automático");
    await p.clicar('[data-tm="salvar"]');
    const auto = (await lerTemaGuardado(p)).meus.find((t) => t.nome === "Automático");
    igual(auto && "brilho" in auto, false, "o tema salvo depois do Automático não tem brilho");
    igual(await varCss(p, "--glow"), misturar("#6FB7FF", "#101820", 0.35), "e o clarão continua o derivado");
    igual("brilho" in (await temaExportado(p)), false, "um tema sem brilho exporta sem o campo");
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
    igual("brilho" in ex, false, "tema sem brilho exporta sem o campo (reimportado, o clarão continua seguindo o destaque)");
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
    const claros = await p.avaliar((ns) => ns.filter((i) => !window.TemaCx.escuro(window.TemaCx.porId(i))).length, novos);
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
    // a etiqueta Claro/Escuro do cartão usa o mesmo critério do app (o que decide o color-scheme e os tons do tema)
    const etiquetas = await p.avaliar(() => [...document.querySelectorAll("#temaBox .tema-card")].map((c) => {
      const b = c.querySelector('[data-tm="usar"]'), t = b && window.TemaCx.porId(b.dataset.id);
      if (!t || !t.fixo) return "";
      const esperada = window.TemaCx.escuro(t) ? "Escuro" : "Claro", h = c.querySelector(".hint").textContent.trim();
      return h === esperada ? "" : `${t.id}: "${h}", o app trata como ${esperada}`;
    }).filter(Boolean));
    igual(etiquetas.join(" | "), "", "etiqueta Claro/Escuro igual ao critério do app");
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
    await p.injetar("window.__quadroLento = 80;");
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
    igual(await p.avaliar(() => window.__quadroLento), 80, "a abertura continua lenta");
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
  "Visual leve automático: 30 quadros por segundo e um tropeço só não ligam": { movimento: true, fn: async (p) => {
    // aparelho em economia de bateria: o navegador limita a 30 quadros por segundo (todos com ~34 ms), sem lentidão de verdade
    await comExemplo(p);
    const leve = () => p.avaliar(() => document.documentElement.hasAttribute("data-leve"));
    await p.injetar("window.__quadroLento = 34;");
    await p.recarregar(); await p.espera(2200);
    igual(await p.avaliar(() => document.querySelector("#inResumo").dataset.abertura), "longa", "a abertura longa tocou");
    igual(await leve(), false, "30 quadros por segundo não ligam o visual leve");
    igual((await lerTemaGuardado(p)).leve, undefined, "e nada é gravado");
    // um tropeço só (ex.: fontes carregando a frio): um quadro de 400 ms no meio de quadros normais
    await p.injetar("window.__quadroLento = [16, 16, 16, 400, 16];");
    await p.recarregar(); await p.espera(2200);
    igual(await leve(), false, "um quadro longo só não liga o visual leve");
    igual((await lerTemaGuardado(p)).leve, undefined, "e nada é gravado");
  } },
  "Tema guardado estragado não impede o app de abrir": async (p) => {
    await comExemplo(p);
    for (const v of ["5", '"x"', "[]", "null", "true"]) {
      await p.avaliar((v) => localStorage.setItem("caixinhas-orologia-tema", v), v);
      await p.recarregar();
      igual(await p.avaliar(() => typeof window.TemaCx), "object", "o motor de temas carrega com a chave " + v);
      igual(await varCss(p, "--bg"), "#110E18", "abre no tema padrão com a chave " + v);
      await p.aba("ajustes/aparencia");
      await p.clicar('#temaBox [data-tm="usar"][data-id="dia"]');
      igual(await varCss(p, "--bg"), "#F2F0F7", "a Aparência funciona com a chave " + v);
      await p.clicar("#tgLeve"); await p.clicar("#tgLeve");
      igual((await lerTemaGuardado(p)).atual, "dia", "e grava de novo com a chave " + v);
      await p.aba("inicio");
    }
    // temas próprios estragados dentro de "meus" (não são objetos, sem as cores, cor inválida) saem ao ler; o bom fica
    const cores = { fundo: "#1A1030", card: "#2A1F45", texto: "#F5F0FF", suave: "#B8A8D8", destaque: "#C78BFF", secundaria: "#FFD27A", raio: 16, fonte: "padrao" };
    const meus = [5, null, "x", [], { id: "t1" }, { id: "t2", nome: "Sem cores", fundo: "#000000" }, Object.assign({ id: "t3", nome: "Brilho ruim", brilho: "azul" }, cores), Object.assign({ id: "tbom", nome: "Bom" }, cores)];
    await p.avaliar((meus) => localStorage.setItem("caixinhas-orologia-tema", JSON.stringify({ atual: "t1", meus })), meus);
    await p.recarregar();
    igual(await p.avaliar(() => typeof window.TemaCx), "object", "o motor de temas carrega com temas próprios estragados");
    igual(await varCss(p, "--bg"), "#110E18", "o tema escolhido estragado cai no padrão");
    igual(await p.avaliar(() => window.TemaCx.estado.meus.map((t) => t.id).join(",")), "tbom", "só o tema próprio bom continua");
    await p.aba("ajustes/aparencia");
    await p.clicar('#temaBox [data-tm="usar"][data-id="tbom"]');
    igual(await varCss(p, "--bg"), "#1A1030", "a Aparência funciona e o tema bom vale");
    igual((await lerTemaGuardado(p)).meus.map((t) => t.id).join(","), "tbom", "ao gravar, os estragados não voltam");
  },
  "Editor de tema mostra como texto o que veio guardado": async (p) => {
    await comExemplo(p); await p.aba("ajustes/aparencia");
    // um tema próprio com HTML no lugar das cores (o que está guardado no aparelho pode ter sido mexido à mão)
    await p.avaliar(() => window.TemaCx.estado.meus.push({ id: "tinj", nome: "Injetado", fundo: '#110E18"><i id="injF"></i>', card: "#1C1827", texto: "#EEEAF5", suave: "#A49EB8", destaque: "#9C9BF5", secundaria: "#E3C98A", brilho: '<i id="injB"></i>', raio: 16, fonte: "padrao" }));
    await p.aba("ajustes/sobre"); await p.aba("ajustes/aparencia");
    await p.clicar('[data-tm="editar"][data-id="tinj"]');
    igual(await p.avaliar(() => document.querySelectorAll("#injF, #injB").length), 0, "nada do que veio guardado vira elemento na página");
    igual(await p.texto("#tmx-brilho"), '<i id="injB"></i>', "o brilho aparece como texto");
    igual(await p.texto("#tmx-fundo"), '#110E18"><i id="injF"></i>', "a cor aparece como texto");
    await p.clicar('[data-tm="cancelar"]');
  },
  "Cabeçalho do Mês e dos Gráficos com o mesmo arranjo em todas as fontes": async (p) => {
    await comExemplo(p);
    const mono = { id: "tmono", nome: "Mono", fundo: "#14141A", card: "#1E1E26", texto: "#EDEDF2", suave: "#A0A0AE", destaque: "#8FA0FF", secundaria: "#E3C98A", raio: 16, fonte: "mono" };
    // noite (Orologia), Grafite (do sistema), Papel (serifada) e um tema próprio com a fonte mono
    for (const [id, meus] of [["noite", []], ["g-grafite", []], ["g-papel", []], ["tmono", [mono]]]) {
      await p.avaliar((id, meus) => localStorage.setItem("caixinhas-orologia-tema", JSON.stringify({ atual: id, meus })), id, meus);
      for (const [w, h] of [[360, 780], [320, 640]]) {
        await p.tamanho(w, h); await p.recarregar();
        for (const aba of ["mes", "graficos"]) {
          await p.aba(aba);
          // o nome de mês mais comprido, para o caso pior
          const r = await p.avaliar((aba) => {
            const v = document.querySelector("#v-" + aba), h2 = v.querySelector(".vhead h2"), m = v.querySelector(".vhead .month");
            h2.querySelector(".cap").textContent = "Fevereiro de 2026";
            const a = h2.getBoundingClientRect(), b = m.getBoundingClientRect();
            return { mesmaLinha: b.top < a.bottom && b.left >= a.right - 1, dentro: b.right <= innerWidth + 0.5, h2: [Math.round(a.left), Math.round(a.top), Math.round(a.right), Math.round(a.bottom)], nav: [Math.round(b.left), Math.round(b.top), Math.round(b.right), Math.round(b.bottom)] };
          }, aba);
          certo(r.mesmaLinha && r.dentro, `${aba} em ${w}px com o tema ${id}: as setas do mês ficam ao lado do título, dentro da tela ` + JSON.stringify(r));
          if (w === 360 && (id === "noite" || id === "g-grafite")) await p.print(`29-cabecalho-${aba}-${id}-${w}`);
        }
      }
    }
  },
  "Financiamento: o PRICE diz a verdade sobre a parcela": async (p) => {
    await calc(p, "fin");
    const ler = () => p.avaliar(() => ({
      sub: document.querySelector("#c-fin .fin-lado > div:nth-child(2) h4 small").textContent.trim(),
      ajuda: document.querySelector("#c-fin .fin-lado > div:nth-child(2)").textContent.replace(/\s+/g, " "),
    }));
    const caso = async (corr, extra) => { await p.digitar("#iCorr", corr); await p.digitar("#iExtra", extra); await p.espera(150); return ler(); };
    const parcelas = () => p.avaliar(() => [...document.querySelectorAll("#finPrice .r .num")].slice(0, 2).map((e) => e.textContent.trim()));
    let r = await caso("0", "");
    igual(r.sub, "parcela igual do começo ao fim", "sem correção nem extra");
    let [a, b] = await parcelas(); igual(a, b, "e de fato a primeira e a última parcela são iguais");
    r = await caso("4", "");
    [a, b] = await parcelas(); certo(a !== b, "com correção a parcela muda: " + a + " / " + b);
    certo(/corre/i.test(r.sub) && !/igual do começo ao fim/.test(r.sub), "com correção o texto diz que a parcela acompanha o índice: " + r.sub);
    r = await caso("0", "500");
    [a, b] = await parcelas(); certo(a !== b, "com amortização extra a última parcela é menor: " + a + " / " + b);
    certo(/última/i.test(r.sub) && !/igual do começo ao fim/.test(r.sub), "com amortização extra o texto avisa da última parcela: " + r.sub);
    r = await caso("0", "");
    igual(r.sub, "parcela igual do começo ao fim", "voltando ao caso simples, o texto volta");
  },
  "Versão é a mesma em todo lugar": async () => {
    const ler = (f) => readFileSync(join(RAIZ, f), "utf8");
    const versao = (ler("index.html").match(/const VERSION = '(\d+\.\d+\.\d+)';/) || [])[1];
    certo(versao, "VERSION no index.html");
    const lock = JSON.parse(ler("package-lock.json"));
    const achadas = {
      "CACHE do sw.js": (ler("sw.js").match(/const CACHE = 'caixinhas-v(\d+\.\d+\.\d+)';/) || [])[1],
      "package.json": JSON.parse(ler("package.json")).version,
      "package-lock.json": lock.version,
      "package-lock.json (pacote raiz)": lock.packages[""].version,
      "primeiro título do CHANGELOG.md": (ler("CHANGELOG.md").match(/^## (\d+\.\d+\.\d+)/m) || [])[1],
    };
    const erradas = Object.entries(achadas).filter(([, v]) => v !== versao).map(([k, v]) => `${k}: ${v}`);
    igual(erradas.join(" | "), "", `tudo na versão ${versao} do index.html`);
    const [a, b] = versao.split(".");
    certo(ler("README.md").includes(`Novidades da ${a}.${b}`), `o README fala das novidades da ${a}.${b}`);
  },
  "Pacote da loja vira DA_LOJA": async () => {
    const html = readFileSync(join(RAIZ, "index.html"), "utf8");
    igual(html.split("const DA_LOJA = false;").length, 2, "o index.html tem a marca do pacote da loja uma vez, desligada");
    // roda o preparo da pasta www numa cópia mínima do app e devolve o index.html que iria para o Android
    const montar = async (loja, conteudo = html) => {
      const pasta = await mkdtemp(join(tmpdir(), "caixinhas-www-"));
      try {
        for (const f of ["manifest.webmanifest", "privacy.html", "icon.svg", "icon-192.png", "icon-512.png", "icon-maskable-512.png"]) await writeFile(join(pasta, f), "");
        await writeFile(join(pasta, "index.html"), conteudo);
        const r = spawnSync(process.execPath, [join(RAIZ, "scripts", "preparar-www.mjs")], { cwd: pasta, encoding: "utf8", env: Object.assign({}, process.env, { CX_LOJA: loja ? "1" : "" }) });
        return { status: r.status, erro: (r.stderr || "").trim(), html: existsSync(join(pasta, "www", "index.html")) ? readFileSync(join(pasta, "www", "index.html"), "utf8") : "" };
      } finally { await rm(pasta, { recursive: true, force: true }); }
    };
    const teste = await montar(false), loja = await montar(true);
    igual(teste.status, 0, "o preparo do APK de teste terminou bem (" + teste.erro + ")");
    certo(teste.html.includes("const DA_LOJA = false;"), "no APK de teste (e no site) o app não é o da loja");
    igual(loja.status, 0, "o preparo da loja terminou bem (" + loja.erro + ")");
    certo(loja.html.includes("const DA_LOJA = true;") && !loja.html.includes("const DA_LOJA = false;"), "no pacote da loja o app sabe que é o da loja");
    const semMarca = await montar(true, html.replace("const DA_LOJA = false;", ""));
    certo(semMarca.status !== 0 && /DA_LOJA/.test(semMarca.erro), "sem a marca, o preparo da loja para com erro em vez de montar um pacote que não sabe que é da loja: " + semMarca.status + " " + semMarca.erro);
    // o workflow da loja: manual, com ensaio, .aab assinado, sem o .teste, sem internet, segredos com o prefixo CX_
    const wl = readFileSync(join(RAIZ, ".github", "workflows", "android-loja.yml"), "utf8"), wt = readFileSync(join(RAIZ, ".github", "workflows", "android.yml"), "utf8");
    certo(/^on:\s*\n\s+workflow_dispatch:/m.test(wl) && !/^\s+push:/m.test(wl), "o workflow da loja só roda quando pedido");
    certo(/ensaio:/.test(wl) && /keytool -genkeypair/.test(wl), "tem o modo ensaio com chave descartável");
    certo(/CX_LOJA=1 npm run www/.test(wl), "monta a www com CX_LOJA=1");
    certo(/CX_LOJA=1 node scripts\/plugin-android\.mjs/.test(wl), "liga o plugin com CX_LOJA=1 (sem o .teste no identificador nem no nome)");
    certo(/applicationIdSuffix/.test(wl), "confere que o identificador não ficou com o .teste");
    certo(/node scripts\/chave-loja-android\.mjs/.test(wl) && /bundleRelease/.test(wl) && /\.aab/.test(wl), "gera o .aab assinado");
    certo(/android\.permission\.INTERNET"' "\$M"; then echo "::error/.test(wl), "falha se a permissão de internet voltar");
    const segredos = [...wl.matchAll(/secrets\.(\w+)/g)].map((x) => x[1]);
    certo(segredos.length >= 3 && segredos.every((s) => s.startsWith("CX_")), "segredos com o prefixo CX_: " + segredos.join(","));
    certo(!/chave-teste-android/.test(wl), "o pacote da loja não usa a chave de teste");
    certo(!/^[^#\n]*CX_LOJA/m.test(wt), "o APK de teste não é o pacote da loja (CX_LOJA só pode aparecer em comentário)");
    // a chave de envio e o versionCode: (a*10000 + b*100 + c) * 10
    const pasta = await mkdtemp(join(tmpdir(), "caixinhas-loja-"));
    try {
      const proj = await projetoAndroidFalso(pasta);
      await writeFile(join(pasta, "index.html"), html);
      const r = spawnSync(process.execPath, [join(RAIZ, "scripts", "chave-loja-android.mjs")], { cwd: pasta, encoding: "utf8" });
      igual(r.status, 0, "o script da chave terminou bem (" + (r.stderr || "").trim() + ")");
      const g = readFileSync(join(proj, "build.gradle"), "utf8"), v = html.match(/const VERSION = '(\d+)\.(\d+)\.(\d+)';/).slice(1).map(Number);
      certo(g.includes(`versionCode ${(v[0] * 10000 + v[1] * 100 + v[2]) * 10}`) && g.includes(`versionName "${v.join(".")}"`), "versionCode pela regra da versão: " + (g.match(/versionCode \d+/) || [])[0]);
      certo(/signingConfig signingConfigs\.loja/.test(g) && /System\.getenv\("CX_CHAVE_SENHA"\)/.test(g) && /System\.getenv\("CX_CHAVE_ALIAS"\)/.test(g), "assina com a chave de envio, senha e apelido só das variáveis");
      // no ensaio o .aab nunca se confunde com o de verdade: versionName termina em -ensaio
      const p2 = await mkdtemp(join(tmpdir(), "caixinhas-loja-"));
      try {
        const proj2 = await projetoAndroidFalso(p2);
        await writeFile(join(p2, "index.html"), html);
        const r2 = spawnSync(process.execPath, [join(RAIZ, "scripts", "chave-loja-android.mjs")], { cwd: p2, encoding: "utf8", env: Object.assign({}, process.env, { CX_ENSAIO: "1" }) });
        igual(r2.status, 0, "o script da chave no ensaio terminou bem (" + (r2.stderr || "").trim() + ")");
        certo(readFileSync(join(proj2, "build.gradle"), "utf8").includes(`versionName "${v.join(".")}-ensaio"`), "no ensaio o versionName termina em -ensaio");
      } finally { await rm(p2, { recursive: true, force: true }); }
      certo(!/versionName "[^"]*-ensaio"/.test(g), "fora do ensaio o versionName é só a versão");
    } finally { await rm(pasta, { recursive: true, force: true }); }
    certo(/CX_ENSAIO: \$\{\{ inputs\.ensaio && '1' \|\| '' \}\}/.test(wl), "o workflow avisa o script da chave quando é ensaio");
    // o INTERNET é conferido no mesmo manifesto final nos dois workflows
    const padrao = (t) => (t.match(/-name AndroidManifest\.xml -path "([^"]+)"/) || [])[1];
    igual(padrao(wl), padrao(wt), "mesmo manifesto final conferido no workflow da loja e no do APK de teste");
    igual(((v) => (v[0] * 10000 + v[1] * 100 + v[2]) * 10)([2, 0, 0]), 200000, "a 2.0.0 vira 200000");
  },
  "Chrome que não abre: tenta de novo e diz o motivo": async () => {
    const prefixo = "caixinhas-chrome-falso-";
    const restos = () => readdirSync(tmpdir()).filter((f) => f.startsWith(prefixo)).length;
    // um "Chrome" que fica aberto sem nunca responder (o caso do servidor do GitHub ocupado) e um que fecha na hora
    for (const [caso, antes] of [["não responde", ["-e", "setTimeout(() => {}, 20000)", "--"]], ["fecha na hora", ["-e", "process.exit(3)", "--"]]]) {
      const t0 = Date.now();
      let erro = null;
      try { const cr = await abrirChrome({ exe: process.execPath, antes, prefixo, limite: 1200 }); await cr.fechar(); } catch (e) { erro = e; }
      certo(erro, `${caso}: devia falhar`);
      certo(/^o Chrome não abriu depois de 2 tentativas/.test(erro.message), `${caso}: mensagem clara: ` + erro.message);
      certo(/tentativa 1: .*tentativa 2: /.test(erro.message), `${caso}: tentou duas vezes: ` + erro.message);
      if (caso === "não responde") certo(Date.now() - t0 >= 2400, `${caso}: esperou o limite nas duas tentativas (${Date.now() - t0} ms)`);
      igual(restos(), 0, `${caso}: os perfis temporários foram apagados`);
    }
  },
  "Visual leve tira clarões e gradientes": async (p) => {
    // a chave fica antes da Galeria: quem recebeu o aviso automático acha sem rolar muito
    await p.aba("ajustes/aparencia");
    const topo = await p.avaliar(() => document.querySelector("#tgLeve").getBoundingClientRect().top + scrollY);
    certo(topo < 1170, "a chave do Visual leve devia estar no começo da Aparência (topo em " + topo + " px)");
    igual(await p.avaliar(() => !!(document.querySelector("#tgLeve").compareDocumentPosition([...document.querySelectorAll("#temaBox h3")].find((h) => h.textContent.trim() === "Galeria")) & Node.DOCUMENT_POSITION_FOLLOWING)), true, "a chave vem antes do título Galeria");
    await p.aba("inicio");
    await comExemplo(p);
    const visual = () => p.avaliar(() => {
      const cs = (q) => getComputedStyle(document.querySelector(q));
      return { corpo: cs("body").backgroundImage, bloco: cs("#inCx .n-bloco[data-cx]").backgroundImage, resumo: cs(".n-resumo") ? cs(".n-resumo").backgroundImage : "none",
        arco: cs("#arco .arco-luz").filter, barra: cs(".tabs").boxShadow, borrao: cs(".tabs").backdropFilter, mais: cs("#fab").boxShadow, vidro: cs("#inRitmo").boxShadow,
        borraoFolha: cs(".folha-caixa").backdropFilter, borraoAviso: cs(".toast").backdropFilter };
    });
    const antes = await visual();
    certo(/gradient/.test(antes.corpo) && /gradient/.test(antes.bloco) && antes.arco !== "none" && antes.barra !== "none", "sem o visual leve há clarões, gradientes e sombras: " + JSON.stringify(antes));
    certo(/blur/.test(antes.borrao) && /blur/.test(antes.borraoFolha) && /blur/.test(antes.borraoAviso), "sem o visual leve a barra, a folha e o aviso têm desfoque: " + JSON.stringify(antes));
    await p.aba("ajustes/aparencia"); await p.clicar("#tgLeve"); await p.aba("inicio");
    igual(await p.avaliar(() => document.documentElement.hasAttribute("data-leve")), true, "a chave põe data-leve no html");
    const depois = await visual();
    igual(JSON.stringify(depois), JSON.stringify({ corpo: "none", bloco: "none", resumo: "none", arco: "none", barra: "none", borrao: "none", mais: "none", vidro: "none", borraoFolha: "none", borraoAviso: "none" }), "o visual leve tira clarões, gradientes, sombras e desfoque (barra, folha e aviso)");
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
        // a galeria não cai para uma coluna no celular estreito
        const colunas = await p.avaliar(() => new Set([...[...document.querySelectorAll("#temaBox .temas")].pop().querySelectorAll(":scope > .tema-card")].map((c) => Math.round(c.getBoundingClientRect().left))).size);
        certo(colunas >= 2, `a galeria tem ao menos duas colunas em ${w}px (${tema}): ${colunas}`);
        await p.print(`24-aparencia-${tema}-${w}`, true);
      }
    }
  },
  "Esqueci o PIN com a edição aberta: a folha fecha e o próximo lançamento é um gasto novo": async (p) => {
    await comExemplo(p);
    await p.aba("ajustes/pin"); await p.digitar("#pinNovo", "1234"); await p.digitar("#pinRep", "1234"); await p.clicar('[data-pin="ativar"]'); await p.espera(400);
    await p.aba("mes"); await p.clicar("#mesLista .n-lanc");
    igual(await p.texto("#gHead"), "Editar gasto", "a folha abriu em edição");
    await p.clicar('[data-pin="agora"]');
    await p.clicar('#trava [data-tk="esqueci"]'); await p.clicar('#trava [data-tk="zerar"]'); await p.clicar('#trava [data-tk="zerar"]');
    await p.espera(500);
    igual(await p.visivel("#trava"), false, "apagar tudo destrava");
    igual(await p.avaliar(() => !document.querySelector("#folhaGasto").hidden), false, "a folha de edição fecha ao apagar tudo");
    igual(await p.texto("#gHead"), "Lançar gasto", "a folha sai da edição");
    igual(await p.abaAtual(), "inicio", "o app volta ao Início");
    igual(await p.avaliar(() => location.hash), "#inicio", "o endereço também é o do Início");
    await lancar(p, 7, "Café"); await p.espera(200);
    const gs = await p.avaliar(() => Object.values(JSON.parse(localStorage.getItem("caixinhas-orologia-v1")).meses).flatMap((m) => m.gastos || []));
    igual(gs.map((g) => g.descricao + ":" + g.valor).join(","), "Café:7", "o lançamento seguinte é um gasto novo, e o único");
  },
  "Contagem fora do Início não mexe no Início escondido": { movimento: true, fn: async (p) => {
    await comExemplo(p); await p.espera(3000); // a abertura do Início termina
    // conta o que muda dentro do Início (a própria tela ser escondida pela troca de aba não conta)
    await p.avaliar(() => { const v = document.querySelector("#v-inicio"); window.__mud = 0; new MutationObserver((l) => { window.__mud += l.filter((m) => m.target !== v).length; }).observe(v, { subtree: true, attributes: true, childList: true, characterData: true }); });
    await p.aba("cartao"); // o total da fatura conta até o valor (uma contagem fora do Início)
    await p.espera(1000);
    igual(await p.avaliar(() => window.__mud), 0, "o Início escondido foi redesenhado durante a contagem do Cartão");
    // e o Início continua certo quando volta
    await p.aba("inicio"); await p.espera(1500);
    igual(await p.texto("#inSobra"), "R$ 1.230,70", "a sobra do Início ao voltar");
  } },
  "Textos de ajuda falam do + e da engrenagem, não da navegação antiga": async (p) => {
    await p.clicar('[data-act="onb-skip"]');
    await p.aba("mes");
    const vazio = await p.texto("#mesLista");
    certo(vazio.includes("Toque no +") && !vazio.includes("“Lançar”"), "o Mês vazio devia mandar tocar no +: " + vazio);
    await p.aba("guia");
    const g = await p.avaliar(() => document.querySelector("#v-guia").textContent.replace(/\s+/g, " "));
    certo(!g.includes("Mês → Lançar gasto"), "o guia ainda fala em Mês → Lançar gasto");
    certo(g.includes("Toque no +") && g.includes("+ Lançar"), "o guia devia falar do + (celular) e do + Lançar (computador)");
    certo(g.includes("engrenagem"), "o guia devia dizer que os Ajustes ficam na engrenagem");
    for (const tema of ["noite", "dia"]) {
      await p.avaliar((tema) => localStorage.setItem("caixinhas-orologia-tema", JSON.stringify({ atual: tema, meus: [] })), tema);
      for (const [w, h] of [[360, 780], [320, 640], [1280, 800]]) {
        await p.tamanho(w, h); await p.recarregar(); await p.aba("guia");
        await p.avaliar(() => document.querySelectorAll("#v-guia details").forEach((d, i) => { d.open = i < 2; }));
        await p.print(`29-guia-${tema}-${w}`);
        await p.aba("mes"); await p.print(`29-mes-vazio-${tema}-${w}`);
      }
    }
  },
  "Tela do PIN respeita as barras do sistema em cima e embaixo": async (p) => {
    await p.avaliar(() => { const r = document.documentElement; r.style.setProperty("--safe-area-inset-top", "30px"); r.style.setProperty("--safe-area-inset-bottom", "20px"); r.setAttribute("data-trava", ""); });
    igual(await p.avaliar(() => { const c = getComputedStyle(document.querySelector("#trava")); return c.paddingTop + "|" + c.paddingBottom + "|" + c.paddingLeft; }), "54px|44px|24px", "recuo da tela do PIN (24 px mais a barra)");
    for (const tema of ["noite", "dia"]) {
      await p.avaliar((tema) => { localStorage.setItem("caixinhas-orologia-tema", JSON.stringify({ atual: tema, meus: [] })); window.TemaCx.aplicar(window.TemaCx.porId(tema)); }, tema);
      for (const [w, h] of [[360, 780], [320, 640], [1280, 800]]) { await p.tamanho(w, h); await p.espera(150); await p.print(`30-pin-recuos-${tema}-${w}`); }
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
let cr;
try { cr = await abrirChrome(); }
catch (e) { console.log("FALHA ao começar\n      " + e.message); srv.close(); process.exit(1); }
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
