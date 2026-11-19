# Material da Google Play

- [`ficha.md`](ficha.md): nome, descrições, respostas do Console e o que fazer lá.
- `pt/`: imagem de destaque (1024×500) e 8 capturas de tela (1080×1920), em português.
- O ícone da loja é o `icon-512.png` da raiz do repositório (512×512).

As capturas, na ordem: Início, Lançar gasto, Gráficos, Mês, Cartão, Metas, Financiamento e Temas (tema Areia).

## Como refazer

`node scripts/prints-loja.mjs loja` gera tudo de novo a partir do app de verdade (Chrome sem janela, nada é instalado).
Para refazer só algumas: `node scripts/prints-loja.mjs loja 3 5` (números das capturas). A imagem de destaque sai junto quando as capturas 1 e 3 são refeitas.
`node scripts/prints-loja.mjs readme` refaz as imagens do README (`docs/`); sem nada, o script faz os dois conjuntos.
Os textos de cada imagem ficam no começo do script.

Os gastos, cartões, metas e valores das imagens são inventados pelo próprio script. O "hoje" das imagens fica preso em 19/11/2026, então rodar de novo dá as mesmas imagens (a não ser que o app mude).
