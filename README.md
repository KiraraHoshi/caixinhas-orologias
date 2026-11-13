# Caixinhas Orologia

App de finanças pessoais em **um único arquivo HTML**: sem servidor, sem conta, sem dependências. Funciona offline e pode ser instalado no celular como um aplicativo (PWA).

**[Abrir o app](https://kirarahoshi.github.io/caixinhas-orologias/)**

## O que ele faz

- **Mês (caixinhas):** limites por caixinha (Lazer, Dia a dia, Objetivos ou as suas), lançamento rápido de gastos com aviso de "cabe / não cabe", sobra por dia, remanejar limite entre caixinhas, limites só do mês ou padrão, e conferência com o saldo real da conta.
- **Cartão e parcelas:** cartões com dia de fechamento e vencimento, compras parceladas e assinaturas, fatura de cada mês, gastos de outras pessoas no seu cartão (quem te deve e o que já foi recebido) e projeção das próximas 6 faturas.
- **Metas e investimentos:** metas com alvo, saldo, aporte mensal e rendimento (prazo calculado com juros compostos), simulador com IR regressivo e inflação, e "quanto guardar por mês" para chegar num valor.
- **Contas (CLT):** salário líquido (INSS progressivo, IRRF com a redução de 2026), adicional noturno com hora reduzida e DSR, 13º salário (1ª e 2ª parcela), férias com 1/3 e abono, e saque-aniversário do FGTS.
- **Apoie:** página de apoio pelo GitHub Sponsors.
- **Aparência:** dois temas grátis (Orologia Noite e Orologia Dia), editor para criar o seu com verificação de contraste, e temas para copiar, baixar ou importar em JSON. O formato é o mesmo do [Compasso Player](#temas): um tema feito num app funciona no outro.
- **Ajustes:** caixinhas, formas de pagamento, taxa de referência (Selic/CDI), **tabelas de impostos editáveis** (para atualizar quando o governo mudar), backup em JSON (exportar / importar) e dados de exemplo.

## Como usar

1. Baixe esta pasta.
2. Abra `index.html` no navegador. Pronto: já funciona.
3. Para instalar no celular, publique a pasta num endereço `https` (por exemplo, **GitHub Pages**: Settings → Pages → Deploy from branch → `main` / root). Abra o endereço no celular e escolha **Adicionar à tela inicial**.

Os dados ficam no `localStorage` do navegador. **Exporte um backup** de vez em quando (Ajustes → Exportar backup), principalmente antes de limpar o navegador ou trocar de aparelho.

Quando aberto como artifact no Claude, o app salva na conta do Claude (privado para cada pessoa) e sincroniza entre aparelhos.

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

`fonte` aceita `padrao`, `sistema`, `serifada` ou `mono`. O `raio` (cantos) é usado só no Compasso Player. O tema escolhido fica salvo neste aparelho e não entra no backup.

## Atualizando as tabelas

Os valores de 2026 vêm de fábrica (INSS até R$ 8.475,55; IRRF com isenção até R$ 5.000 e redução até R$ 7.350; tabela do saque-aniversário). Em Ajustes → Tabelas dá para editar tudo. Para mudar o padrão no código, edite a constante `T2026` em `index.html`.

## Arquivos

| Arquivo | Para quê |
|---|---|
| `index.html` | O app inteiro (HTML, CSS e JS) |
| `manifest.webmanifest` | Nome, cores e ícones para instalar |
| `sw.js` | Guarda o app para abrir sem internet |
| `icon.svg`, `icon-192.png`, `icon-512.png` | Ícones |
| `privacy.html` | Política de privacidade (exigida pela Google Play) |

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
