# Chave dos APKs de teste

`teste-debug.keystore` assina só os APKs de teste da página de Releases (senha `android`, alias `androiddebugkey`, iguais às da chave de depuração padrão do Android).
Ela é fixa para que cada APK de teste novo instale por cima do anterior, sem precisar desinstalar.

Não é a chave da Google Play. A versão da loja usa outra chave, guardada fora do repositório.
