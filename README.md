# Orolon Caixinhas

App de finanças pessoais em **um único arquivo HTML**: sem servidor, sem conta, sem dependências. Funciona offline e pode ser instalado no celular como um aplicativo (PWA).

**[Abrir o app](https://kirarahoshi.github.io/caixinhas-orologias/)**

## O que ele faz

- **Versão 1.9:**
  - **Calculadoras** numa tela só: as contas CLT, o **financiamento de imóvel** (SAC e PRICE lado a lado, com correção, amortização extra e aviso quando a parcela passa de 30% da renda), os juros compostos e o "quanto guardar por mês" (os dois últimos saíram da tela Metas).
  - **A vencer:** o Início avisa das faturas e dos gastos fixos que vencem nos próximos 7 dias.
  - **Ajustes em partes:** Caixinhas, Pagamento e rendimento, Aparência, Bloqueio por PIN, Backup e dados, Lembretes e Sobre.
  - **Mês mais curto:** a lista mostra os 8 lançamentos mais recentes e o resto a pedido.
  - **App Android (em teste):** o mesmo app, empacotado. Botão voltar fecha uma coisa por vez, backup e planilha saem pelo compartilhamento, backup automático numa pasta escolhida (cada aparelho só mexe nas cópias dele) e lembrete de contas a vencer por notificação. Detalhes em [ANDROID.md](ANDROID.md).
- **Ajustes de acabamento (1.8.4):** na abertura curta só o anel e as barras se movem (os números já aparecem certos); o número grande da sobra não muda de tamanho durante a contagem; o aviso "passou R$ X" não é mais cortado em nomes de caixinha compridos; gastar além do limite durante a abertura longa não interrompe mais o giro do mostrador.
- **Movimento (1.8):** o app reage ao que você faz. Na primeira abertura do dia o mostrador gira e se desenha, e a sobra conta até o valor (nas outras, uma versão curta). Ao lançar, o pedaço do anel cresce, a sobra desce e o valor lançado passa pelo centro; se a caixinha estoura, ela treme e mostra "passou R$ X". Meta batida ganha brilho e faíscas, e os gráficos se desenham ao aparecer. Com "reduzir movimento" ligado no aparelho, tudo aparece parado.
- **Backup automático (1.7):** o app guarda sozinho uma cópia por dia neste aparelho (7 dias) e mais uma antes de importar ou apagar tudo, para desfazer um erro. Onde o navegador deixa (Chrome e Edge no computador), dá para escolher uma pasta e ele grava ali um arquivo por dia, mantendo os 7 mais recentes; numa pasta que sincroniza com a nuvem, o backup sai do aparelho sem conta nem servidor. No celular, "Enviar backup" abre o compartilhamento do sistema.
- **Visual novo (1.6):** no Início, um mostrador grande em que cada pedaço do anel é uma caixinha (o tamanho é o limite, a parte acesa é o gasto) e o fio dourado em volta mostra quanto do mês já passou. Telas mais limpas, títulos sem caixa alta e ícone novo, irmão do ícone do Orolon.
- **Lançar de qualquer tela (1.5):** o botão "Lançar" fica sempre à mão e abre uma folha com valor, caixinha e o aviso de "cabe / não cabe"; editar um gasto usa a mesma folha. No celular, o botão voltar fecha só a folha.
- **Início mais direto (1.5):** a sobra do mês, todas as caixinhas com a sobra de cada uma, fatura, metas e atalhos.
- **Caixinhas com ícone (1.5):** cada caixinha tem um ícone na cor dela (27 opções, em Ajustes → Caixinhas). O app sugere um pelo nome.
- **Busca, gráficos e planilha:** busca e filtros nos lançamentos (inclusive em todos os meses), comparação com o mês anterior por caixinha (no mês atual, até o mesmo dia), total dos últimos 6 meses, e exportação em CSV para Excel ou Google Planilhas.
- **Bloqueio por PIN:** PIN de 4 a 6 números para abrir o app neste aparelho, com tempo para bloquear de novo. Os dados não são criptografados e o PIN não entra no backup; quem esquece o PIN só entra apagando os dados.
- **Caixinhas à sua maneira:** criar, renomear, reordenar, trocar a cor (paleta ou cor livre) e remover; ao remover uma caixinha com gastos, o app leva os gastos para outra. No primeiro uso há modelos prontos (Simples, Detalhada, Enxuta).
- **Guia e ajuda:** um guia rápido ("Como usar") no topo do Início e botões “?” nas seções que mais geram dúvida.
- **Início:** resumo do mês (sobra, sobra por dia, caixinhas que pedem atenção), fatura do cartão, metas e atalhos. Na primeira abertura, um passo a passo curto (o que são caixinhas, limites, visual).
- **Mês (caixinhas):** limites por caixinha (Lazer, Dia a dia, Objetivos ou as suas), lançamento rápido de gastos com aviso de "cabe / não cabe", **edição de gastos**, **entradas de dinheiro**, **gastos fixos** que se lançam sozinhos todo mês, sobra por dia, remanejar limite entre caixinhas, limites só do mês ou padrão, e conferência com o saldo real da conta.
- **Cartão e parcelas:** cartões com dia de fechamento e vencimento, compras parceladas e assinaturas, fatura de cada mês, gastos de outras pessoas no seu cartão (quem te deve e o que já foi recebido) e projeção das próximas 6 faturas.
- **Metas e investimentos:** metas com alvo, saldo, aporte mensal e rendimento (prazo calculado com juros compostos), simulador com IR regressivo e inflação, e "quanto guardar por mês" para chegar num valor.
- **Calculadoras (CLT), no Início:** salário líquido (INSS progressivo, IRRF com a redução de 2026), adicional noturno com hora reduzida e DSR, 13º salário (1ª e 2ª parcela), férias com 1/3 e abono, e saque-aniversário do FGTS.
- **Apoie:** página de apoio pelo GitHub Sponsors (link no Início e em Ajustes).
- **Aparência:** dois temas principais (Orologia Noite e Orologia Dia), a **galeria** do Orolon embutida (Brasa, Entardecer, Folha, Maré, Meia-noite e Papel), editor para criar o seu com verificação de contraste, e temas para copiar, baixar ou importar em JSON. O formato é o mesmo do [Orolon Player](https://github.com/KiraraHoshi/compasso-player) ([abrir o player](https://kirarahoshi.github.io/compasso-player/)): um tema feito num app funciona no outro.
- **Ajustes:** caixinhas, formas de pagamento, taxa de referência (Selic/CDI), **tabelas de impostos editáveis** (para atualizar quando o governo mudar), backup em JSON (exportar / importar) e dados de exemplo.

## Como usar

1. Baixe esta pasta.
2. Abra `index.html` no navegador. Pronto: já funciona.
3. Para instalar no celular, publique a pasta num endereço `https` (por exemplo, **GitHub Pages**: Settings → Pages → Deploy from branch → `main` / root). Abra o endereço no celular e escolha **Adicionar à tela inicial**.

Os dados ficam no `localStorage` do navegador. **Exporte um backup** de vez em quando (Ajustes → Exportar backup), principalmente antes de limpar o navegador ou trocar de aparelho.

## Temas

Um tema é um JSON pequeno, com as cores em `#RRGGBB`. Os tons de borda, campos e trilhas são calculados a partir delas.

```json
{
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
}
```

`fonte` aceita `padrao`, `sistema`, `serifada` ou `mono`. O `raio` (cantos, de 0 a 28, padrão 16) é usado só no Orolon Player. O tema escolhido fica salvo neste aparelho e não entra no backup.

O formato está descrito em [`tema.schema.json`](tema.schema.json) (JSON Schema), o mesmo contrato usado pelo Orolon. Arquivos com outro `formato` são recusados; campos desconhecidos são ignorados.

## Atualizando as tabelas

Os valores de 2026 vêm de fábrica (INSS até R$ 8.475,55; IRRF com isenção até R$ 5.000 e redução até R$ 7.350; tabela do saque-aniversário). Em Ajustes → Tabelas dá para editar tudo. Para mudar o padrão no código, edite a constante `T2026` em `index.html`.

## Arquivos

| Arquivo | Para quê |
|---|---|
| `index.html` | O app inteiro (HTML, CSS e JS) |
| `manifest.webmanifest` | Nome, cores e ícones para instalar |
| `sw.js` | Guarda o app para abrir sem internet |
| `icon-simbolo.svg` | Desenho do símbolo; `node scripts/gerar-icones.mjs` gera os ícones a partir dele |
| `icon.svg`, `icon-192.png`, `icon-512.png`, `icon-maskable-512.png` | Ícones gerados |
| `tema.schema.json` | Descrição do formato de tema (compartilhado com o Orolon Player) |
| `privacy.html` | Política de privacidade (exigida pela Google Play) |
| `testes/rodar.mjs` | Testes automáticos: `node testes/rodar.mjs` abre o app num Chrome sem janela e confere as telas (sem bibliotecas) |

## Privacidade e segurança

- **Nada vai para a internet.** O `index.html` não usa fontes, scripts nem imagens de outros sites, e traz uma política de segurança (CSP) que **proíbe qualquer conexão de rede para fora**. O único link externo é o da aba Apoie, e ele só abre se você tocar nele.
- **Sem conta, sem servidor, sem rastreio.** Os dados ficam no `localStorage` do seu navegador.
- **Os dados não são criptografados.** Quem abrir o mesmo navegador no mesmo aparelho consegue vê-los. Use bloqueio de tela e não use em computador compartilhado.
- **Faça backup** (Ajustes → Exportar) e guarde o arquivo num lugar seguro. Importe só backups que você mesmo gerou.
- Para conferir, procure por `http` dentro do `index.html` (só deve aparecer o link do Sponsors) e abra a aba Rede das ferramentas do navegador: não há pedidos além dos arquivos do próprio app.
- As fontes são as do seu sistema (Constantia/Georgia nos títulos). Para usar Cinzel, instale-a no aparelho.

## Apoie o projeto

O app é gratuito e sem anúncios, e apoiar não destrava nada. Se ele te ajudou e você quiser retribuir, use o botão **Sponsor** deste repositório ou a aba **Apoie** dentro do app: [github.com/sponsors/KiraraHoshi](https://github.com/sponsors/KiraraHoshi). Estrelas, correções nas tabelas de impostos e sugestões também ajudam.

## Aviso

Este app faz estimativas e não é consultoria financeira, contábil ou jurídica. Confira os valores com o seu holerite, o RH ou um profissional.

## Licença

MIT. Use, copie, modifique e distribua à vontade.
