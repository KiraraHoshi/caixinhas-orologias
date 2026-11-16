# Orolon Caixinhas 1.8: movimento

Desenho curto, aprovado pelo Jo-ah em 16/11/2026.

## Por que
O app estava "seco": mostrador, barras e gráficos aparecem prontos e são redesenhados do zero a cada mudança. O Jo-ah testou um protótipo com três tons e escolheu o **"Vivo"**: o app reage com emoção, sem exagerar.

## Metas
- O app reage ao que a pessoa faz: lançar, estourar uma caixinha, bater uma meta.
- Abrir o app tem um momento bonito, mas que não cansa.
- Os números nunca mentem durante a animação: o valor final é sempre o valor real.

## Não metas
- Movimento no player (o protótipo `movimento-orolon.html` é do Orolon Player).
- Encurtar as telas Mês e Metas, dividir Ajustes.
- Som ou vibração.

## Antimetas
- Animação que atrasa o uso: nada bloqueia toque; qualquer ação nova interrompe a animação em curso e mostra o valor final.
- Abertura longa toda vez que a pessoa volta ao Início.
- Dados reiniciados para "mostrar" a animação (o protótipo fazia isso só para demonstrar; o app nunca).

## Restrições
- Um arquivo só (`index.html`), sem bibliotecas, sem rede.
- Com "reduzir movimento" ligado no aparelho, tudo aparece parado, como na 1.7.
- Funciona com qualquer tema (`orologia-tema`), claro ou escuro.
- Os testes existentes continuam valendo.

## Abordagens consideradas
1. **Estado único animado (escolhida).** As peças do Início (mostrador, lista de caixinhas) ficam fixas na tela; um motor pequeno anima números (`vis`) e uma função `desenhar` aplica esses números nos elementos. É como o protótipo aprovado foi feito, então o resultado é o que o Jo-ah já viu.
2. **Só CSS (transições e keyframes).** Mais simples, mas o app redesenha o HTML inteiro a cada mudança, o que reinicia as transições; e contar o valor da sobra não dá para fazer só com CSS.
3. **Biblioteca de animação.** Descartada pela regra "sem bibliotecas".

## O que se move

Tempos e curvas: os do protótipo (`Projetos/Caixinhas Orologia/.superpowers/brainstorm/8129-1794850411/content/movimento-inicio.html`, tom "vivo").

| Momento | O que acontece |
|---|---|
| **Abrir, versão longa** | O mostrador gira (−14°) e se desenha em 0,7 s; o fio âmbar corre até hoje (1 s); cada pedaço do anel cresce em sequência (0,85 s, 85 ms entre eles); a sobra conta junto; as caixinhas entram em sequência. |
| **Abrir, versão curta** | Só os pedaços do anel e as barras crescem, rápido (0,35 s, sem sequência, sem giro). |
| **Lançar gasto (no Início)** | O pedaço do anel engrossa (15 → 21 → 15) e cresce; a sobra desce até o valor novo (0,56 s); o valor da caixinha pisca em âmbar; "− R$ X" sobe e some no centro do mostrador. |
| **Lançar gasto (no Mês)** | A barra da caixinha cresce e o valor dela pisca em âmbar. |
| **Caixinha estourou** | No momento em que passa do limite: fica vermelha, a linha treme uma vez (0,38 s), um anel vermelho abre e some uma vez; aparece "passou R$ X" ao lado do nome (esse texto fica enquanto estiver estourada). |
| **Meta batida** | Ao aportar e chegar ao alvo: a barra completa, fica verde, passa um brilho, o "certo" se desenha e saem 12 faíscas da ponta. |
| **Gráficos** | Quando o gráfico aparece na tela (abrir a seção ou trocar de aba): as barras sobem em sequência com leve passada do ponto; a curva do simulador se desenha, a área aparece e a bolinha do fim "pinga". Vale para: últimos 6 meses (Mês), próximas faturas (Cartão) e simulador (Metas). |

## Decisões do Jo-ah
- Tom "Vivo".
- **A abertura longa toca uma vez; depois, só a curta.** "Uma vez" = a primeira vez que o Início aparece em cada dia (guardado neste aparelho). Nas outras aberturas do dia e ao voltar para o Início, a versão curta.
- O app nunca reinicia dados para animar.

## Decisões de quem escreveu (para o Jo-ah conferir)
- A versão curta toca ao abrir o app e ao voltar para a aba Início, no máximo uma vez a cada 2 s.
- Os gráficos animam uma vez a cada vez que aparecem; mudar os números do simulador redesenha sem animar (senão pisca a cada tecla).
- A meta batida toca na tela Metas, na hora do aporte que alcança o alvo; não toca de novo ao reabrir a tela.
- Depois de lançar no Início, o aviso de texto (toast) continua aparecendo.
- Os testes automáticos rodam com "reduzir movimento" ligado; testes novos ligam o movimento para conferir que os valores chegam ao final certo e que a abertura longa toca uma vez só.

## Fica com quem construir
- Nomes de funções e onde cada trecho entra no `index.html`.
- Ajuste fino de tempos se algo parecer lento num celular fraco.
