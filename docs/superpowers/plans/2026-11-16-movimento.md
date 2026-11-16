# Movimento (1.8.0): plano de implementação

> **Para quem for executar:** execute tarefa por tarefa. Os passos usam caixas (`- [ ]`).

**Objetivo:** o app reage com movimento (tom "Vivo") ao abrir, lançar, estourar uma caixinha, bater uma meta e mostrar gráficos.

**Arquitetura:** um motor pequeno (`tween` + `anima`) anima números guardados em `Vis`; o mostrador e a lista de caixinhas do Início passam a ser montados uma vez e atualizados por `desenharInicio()`, em vez de trocar o HTML a cada mudança. O resto (Mês, Metas, gráficos) continua sendo redesenhado e ganha animações pontuais por cima, com a API de animação do navegador.

**Tecnologia:** HTML, CSS e JavaScript puro, tudo em `index.html`. Testes em `testes/rodar.mjs` (Chrome sem janela).

**Desenho:** `docs/superpowers/specs/2026-11-16-movimento-design.md`. Tempos e curvas: protótipo `Projetos/Caixinhas Orologia/.superpowers/brainstorm/8129-1794850411/content/movimento-inicio.html`, tom "vivo".

## Regras gerais
- Um arquivo só, sem bibliotecas, sem rede.
- Com `prefers-reduced-motion: reduce`, nada se move: os valores aparecem prontos, como na 1.7.
- O valor final na tela é sempre o valor real; qualquer ação nova interrompe a animação em curso e mostra o final.
- O app nunca reinicia dados para animar.
- Funciona em tema claro e escuro (cores só por variáveis do tema).
- Textos em português; nenhuma menção a ferramentas usadas no desenvolvimento; commits como Jo-ah.
- Rodar `node testes/rodar.mjs` antes de cada commit; todos os testes antigos continuam passando.

## Pontos de atenção na revisão
1. Lançar um gasto **durante** a abertura longa: a sobra termina no valor real, sem voltar ao antigo. (Teste na tarefa 3.)
2. Criar, remover ou reordenar caixinhas, importar backup, apagar tudo: o Início é remontado com as caixinhas certas. (Teste na tarefa 2.)
3. Caixinha com limite 0 e gasto maior que 0, e mês sem nenhum limite: o mostrador não quebra (sem `NaN` nos atributos). (Teste na tarefa 2.)
4. Aba do navegador em segundo plano durante a animação (o relógio de animação para): ao voltar, os valores estão certos. (Teste na tarefa 1: `pararMov()` no `visibilitychange`.)
5. Vários lançamentos seguidos, rápidos: nada acumula nem fica torto; o último valor vence. (Teste na tarefa 3.)

---

### Task 1: motor de movimento e testes com movimento desligado

**Arquivos:** `index.html` (bloco novo logo depois de `let S = normalize(...)`), `testes/rodar.mjs`.

**Produz:**
- `movLigado(): boolean` — falso com `prefers-reduced-motion: reduce`.
- `tween(set: (v:number)=>void, de: number, para: number, ms: number, espera = 0, ease = outQuart): Promise<void>` — com movimento desligado ou `ms <= 0`, chama `set(para)` e `desenharInicio()` na hora.
- `anima(el, quadros, opcoes): Animation | null` — `el.animate(...)`; devolve `null` com movimento desligado ou `el` ausente.
- `pararMov(): void` — leva todos os tweens ao valor final e limpa a fila.
- `outQuart`, `outBack` (as do protótipo).
- Em `testes/rodar.mjs`: os testes rodam com movimento **desligado** por padrão (`Emulation.setEmulatedMedia`, `prefers-reduced-motion: reduce`); um teste pode pedir movimento declarando-se como `{ movimento: true, fn: async (p) => {...} }`.

- [ ] **Passo 1:** em `testes/rodar.mjs`, aceitar as duas formas de teste (função ou `{ movimento, fn }`) e emular `prefers-reduced-motion` conforme o caso, antes de navegar. Rodar: os 11 testes passam.
- [ ] **Passo 2:** escrever o teste `"Sem movimento: nada anima"` (padrão, movimento desligado): depois de `comExemplo`, `document.getAnimations().length === 0` e a sobra já é `R$ 1.230,70` sem esperar.
- [ ] **Passo 3:** implementar o motor em `index.html`. O laço usa `requestAnimationFrame`; cada passo chama `desenharInicio()` (definida na tarefa 2; até lá, função vazia). `document.addEventListener('visibilitychange', ...)` chama `pararMov()` quando a página fica oculta.
- [ ] **Passo 4:** rodar os testes; commit `Movimento: motor de animação e testes com movimento desligado`.

### Task 2: Início fixo e abertura longa/curta

**Arquivos:** `index.html` (`mostrador`, `renderInicio`, CSS do `.hero`), `testes/rodar.mjs`.

**Consome:** tarefa 1.

**Produz:**
- `Vis = { chave: '', g: {} /* gasto visto por id de caixinha */, ent: {} /* 0..1, entrada da linha */, dia: 0 /* % do mês */, seg: {}, linhas: {} }`.
- `montarInicio(R)` — monta o SVG do mostrador e as linhas das caixinhas quando `Vis.chave` muda. A chave junta mês, ids, cores, ícones, nomes e limites das caixinhas.
- `desenharInicio()` — aplica `Vis` nos elementos: `stroke-dasharray` de cada pedaço, largura das barras, sobra de cada caixinha, sobra do mês (`#inResumo .big`), valor por dia, "Gasto", ponto e fio âmbar. Vermelho quando o gasto visto passa do limite.
- `renderInicio()` — monta se preciso, calcula os alvos e: na primeira vez que o Início aparece, toca a abertura; nas demais, leva `Vis` aos alvos com `tween` curto (0,35 s) se mudou.
- `abertura(longa: boolean)` — longa: giro do mostrador (0,7 s, de `scale(.94) rotate(-14deg)`), fio até hoje (1 s, espera 80 ms), pedaços (0,85 s, espera `160 + i*85` ms), linhas entram (0,42 s, espera `240 + i*60` ms). Curta: pedaços e barras de 0 ao alvo em 0,35 s, sem sequência.
- A longa toca uma vez por dia: chave `caixinhas-orologia-abertura` no `localStorage` com a data de hoje. `#inResumo` recebe `data-abertura="longa" | "curta"` (para os testes).
- A curta também toca ao voltar para a aba Início (em `route`), no máximo uma vez a cada 2 s.
- Mantidos para os testes e para a ajuda: classes `.big`, `.dial`, `.cxl`, `.cxi`; o botão `?` continua funcionando.

- [ ] **Passo 1 (testes, movimento ligado):**
  - `"Abertura longa toca uma vez por dia"`: após `comExemplo` e espera de 2,2 s, `#inResumo[data-abertura="longa"]` e sobra `R$ 1.230,70`; recarregar a página (`location.reload()`), esperar 1 s: `data-abertura="curta"` e sobra `R$ 1.230,70`.
  - `"Durante a abertura a sobra conta até o valor"`: 150 ms depois de recarregar com a chave de abertura apagada, o texto da sobra é diferente de `R$ 1.230,70`; 2,2 s depois é igual.
- [ ] **Passo 2 (testes, movimento desligado):**
  - `"Início se refaz quando as caixinhas mudam"`: em Ajustes, `cx-add` + `cx-save`; no Início há 4 `.cxl`.
  - `"Mostrador aguenta caixinha sem limite"`: via `localStorage` semeado (limites 0 e um gasto), recarregar: nenhum atributo do `.dial` contém `NaN` e não há erro no console.
- [ ] **Passo 3:** implementar; rodar tudo; conferir os prints `02-inicio` (escuro) e um print novo `07-inicio-claro` no tema Orologia Dia.
- [ ] **Passo 4:** commit `Movimento: Início fixo com abertura longa uma vez por dia`.

### Task 3: lançar e estourar

**Arquivos:** `index.html` (envio do `fGasto`, `renderMes`, CSS), `testes/rodar.mjs`.

**Consome:** `tween`, `anima`, `Vis`, `desenharInicio`.

**Produz:**
- `reagirGasto(idCaixinha: string, valor: number, antes: {gasto, limite}, depois: {gasto, limite})` — chamada depois de salvar um gasto novo (não em edição).
  - No Início: pedaço engrossa (`strokeWidth` 15 → 21 → 15, 0,52 s); valor da caixinha pisca âmbar (0,7 s); ficha `#inFicha` com "− R$ X" sobe e some no centro (1,1 s); o `tween` de 0,56 s até o valor novo já vem de `renderInicio`.
  - No Mês: a barra da caixinha cresce da largura antiga até a nova (0,56 s) e o valor pisca âmbar.
  - Se `antes.gasto <= antes.limite` e `depois.gasto > depois.limite` (com limite > 0): depois de 0,3 s, a linha treme (0,38 s; quadros do protótipo) e, no Início, um anel vermelho abre e some (0,65 s).
- Texto "passou R$ X" ao lado do nome da caixinha estourada, no Início (elemento `small` dentro do `b`) — fica enquanto estiver estourada, com ou sem movimento.

- [ ] **Passo 1 (testes):**
  - movimento desligado, `"Estourou: mostra quanto passou"`: com exemplo, lançar 600 em Lazer: a linha do Lazer no Início contém `passou R$ 79,90`.
  - movimento ligado, `"Lançar no meio da abertura termina no valor certo"`: recarregar sem a chave de abertura, lançar 50 aos 300 ms; 2,5 s depois a sobra é `R$ 1.180,70`.
  - movimento ligado, `"Lançamentos seguidos não se atropelam"`: lançar 10, 20 e 30 com 150 ms entre eles; 1,5 s depois a sobra é `R$ 1.170,70` e `document.getAnimations()` está vazio.
- [ ] **Passo 2:** implementar; rodar tudo.
- [ ] **Passo 3:** commit `Movimento: lançar gasto e caixinha estourada`.

### Task 4: meta batida

**Arquivos:** `index.html` (`renderMetas`, caso `meta-aportar`, CSS), `testes/rodar.mjs`.

**Produz:**
- Meta com `atual >= alvo` mostra a barra verde, o texto `Meta batida` e um "certo" desenhado (SVG), com ou sem movimento.
- `celebrarMeta(idMeta: string)` — chamada no aporte que leva `atual` de abaixo para igual ou acima do alvo: a barra vai da largura antiga a 100% (0,9 s), passa um brilho (0,8 s), o "certo" se desenha (0,38 s), o percentual dá um pulo (0,36 s) e 12 faíscas saem da ponta (0,65–1 s; cores `--ok` e `--gold`), removidas ao terminar.

- [ ] **Passo 1 (testes):**
  - movimento desligado, `"Meta batida aparece como batida"`: com exemplo, aportar 2500 na meta Viagem: o cartão dela contém `Meta batida` e nenhum elemento `.faisca` existe.
  - movimento ligado, `"Meta batida solta faíscas e limpa depois"`: mesmo aporte: logo após, há `.faisca`; 1,6 s depois, nenhuma.
- [ ] **Passo 2:** implementar; rodar tudo.
- [ ] **Passo 3:** commit `Movimento: meta batida`.

### Task 5: gráficos

**Arquivos:** `index.html` (`barChart`, `areaChart`, pontos onde aparecem), `testes/rodar.mjs`.

**Produz:**
- `animarGraficos(raiz: Element)` — anima os gráficos dentro de `raiz`: barras sobem do zero em sequência (0,7 s, espera `i*75` ms, curva `cubic-bezier(.3,1.4,.5,1)` para a passada do ponto; `transform: scaleY` com origem na base); curva do simulador se desenha (1,3 s, `pathLength="1"`), a área aparece (0,7 s), a linha tracejada aparece (0,5 s), a bolinha pinga (0,38 s).
- Chamadas: ao abrir `#dGraf` (evento `toggle`), ao entrar nas abas Cartão e Metas (`route`). Mudar os campos do simulador redesenha sem animar.
- `barChart` marca cada barra com `class="gb"` e `data-i`; `areaChart` marca `class="ga-area" | "ga-tot" | "ga-ap" | "ga-bola"`.

- [ ] **Passo 1 (testes):**
  - movimento ligado, `"Gráfico de faturas anima ao entrar e termina igual"`: com exemplo, ir para Cartão: há animações em `#cartProj`; 1,6 s depois não há, e a altura de cada `.gb` (via `getBoundingClientRect`) é maior que zero.
  - movimento desligado: coberto por `"Sem movimento: nada anima"` (acrescentar visita às abas Cartão e Metas).
- [ ] **Passo 2:** implementar; rodar tudo.
- [ ] **Passo 3:** commit `Movimento: gráficos`.

### Task 6: versão e registros

- [ ] `VERSION = '1.8.0'` em `index.html`; `CACHE = 'caixinhas-v1.8.0'` em `sw.js`; item "Movimento (1.8)" no topo de "O que ele faz" do `README.md`.
- [ ] Atualizar o resumo do projeto (fora do repositório): seção "Movimento" passa a "implementado na branch `1.8-movimento`".
- [ ] Rodar todos os testes; commit `v1.8.0: movimento`.
