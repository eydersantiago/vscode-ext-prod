# Change Log

All notable changes to the "adaceen" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [0.0.37] - 2026-10-25

Pedidos del 25 de octubre: «mira por qué sucede esto» (la ventana flotante decía a la vez «El tutor no esta disponible…» y «El tutor respondió sin código para esto») y «que se compruebe que la extensión de VS Code sí se haya instalado en el túnel en la última versión». Va con el backend y la extensión de navegador 0.8.4 del mismo día; con un backend anterior funciona igual (la cabecera nueva se ignora).

### Corregido

- **El tutor sin modelo ya no se contradice.** Con la GPU apagada (el 25/10 la V100 quedó detenida al pasarla a modo clase), la ventana de la selección mostraba el mensaje del backend «El tutor no esta disponible en este momento…» y debajo «El tutor respondió sin código para esto. Prueba «Otra sugerencia»…», como si el tutor hubiera contestado. Ahora una sugerencia degradada del foco (`degraded` del backend) se marca `unavailable` (`active-suggestion.ts`) y la ventana dice «El tutor no está disponible ahora: el servidor del modelo no respondió.» con qué hacer mientras («revisa el primer error que muestra el compilador y la línea que indica») y deja «Otra sugerencia» y «Resumen y material» (`selection-widget-text.ts`). No ofrece aplicar ni pedir código, no agrega la nota «respondió sin código» (`extension.ts`) y no entra al historial de sugerencias (`suggestion-history.ts`).

### Agregado

- **Cabecera `x-adaceen-vscode-version`** en las llamadas al backend (`client-identity.ts`, `setExtensionVersion` con la versión del `package.json` al activar): el backend sabe qué versión de la extensión hay en cada editor (túnel, VS Code instalado o Codespaces) y el aviso del paso 4 de la extensión de navegador dice si es la última. Solo viaja una versión `x.y.z`.

## [0.0.36] - 2026-10-25

Pedido del 25 de octubre: «refuerza más la extensión de VS Code, para que muestre un cuadro con las dependencias del archivo». Va con el backend del mismo día.

### Agregado

- **Cuadro «Dependencias»** en la vista «ADACEEN · Este archivo», debajo de «De qué trata» y plegado tras «Ver dependencias» (`file-dependencies.ts`, sin `vscode` y con pruebas; `dependency-scan.ts`):
  - «Usa de tu proyecto»: los archivos que incluye o importa (`#include "x"`, `import`, `from … import`, `require`, `require_relative`, `using`), con las clases y funciones que usa de cada uno; un clic abre el archivo. En Java y C#, también las clases del mismo paquete (o del proyecto) que se usan sin import.
  - «Bibliotecas»: cada una con una línea de para qué sirve (`iostream`: entrada y salida por consola; `java.util.Scanner`: leer datos del teclado; `math`: funciones matemáticas…). Un clic lleva a la línea del import. `conio.h`, `windows.h` e `iostream.h` traen un aviso: en Linux (la VM de editores) o en un compilador actual no existen.
  - «No encontradas»: lo que no está en el proyecto, con el archivo de nombre parecido («¿Quisiste decir «src/figura.h»?») o el módulo de Python parecido (`import maths` → `math`). Antes de darlo por perdido se busca en el disco: el índice tiene a lo sumo 90 archivos y no todas las extensiones (un `.tpp` o un `.hh` no están).
  - «La usan»: los archivos del proyecto que lo incluyen o importan; un clic los abre en esa línea. En un `.h` que nadie incluye lo dice.
  - Avisos de errores clásicos aunque se encuentre: mayúsculas que no coinciden (`#include "Circulo.h"` con `circulo.h`, o `<Vector>`, compilan en Windows y no en Linux), un archivo propio incluido con `< >`, un `.cpp` incluido (suele dar «multiple definition») y, en Python, un archivo propio que se llama como un módulo de Python (`random.py` tapa a `random`; `turtle.py` con `import turtle` se importa a sí mismo).
  - C y C++, Python, Java, JavaScript y TypeScript, Ruby y C#. Se lee el texto sin comentarios ni docstrings; no compila nada. En C++ tiene en cuenta el `CMakeLists.txt` o el `Makefile` del proyecto (no están en el índice): con ellos, un `.h` de otra carpeta del mismo proyecto se encuentra. Se actualiza al cambiar de pestaña, 1,5 s después de dejar de escribir, al guardar otro archivo, al cambiar el lenguaje del archivo, al crear, borrar o renombrar archivos y cuando un archivo cambia fuera de VS Code (git pull, otro editor); con la vista oculta no se calcula.
  - Para no llenar la vista, va plegado: «Ver dependencias» lo abre (si falta algo, «N sin encontrar» se ve aunque esté plegado) y cada grupo es un acordeón con su número que se abre con un clic. Lo abierto se recuerda al cambiar de archivo y al recargar la vista; un grupo largo muestra 6 y «Ver N más».
- Comando «ADACEEN: Ver dependencias del archivo»: abre la vista en el cuadro.
- Telemetría `vscode_dependency_opened` (value: local, libraries, missing o dependents) para medir el uso del cuadro.

### Cambiado

- **La vista sigue al editor activo.** Mostraba el archivo de la última sugerencia: al cambiar de pestaña seguía con el nombre y el resumen del anterior hasta que llegaba otra sugerencia. Ahora muestra el archivo activo (con su cuadro aunque todavía no haya sugerencia), no mezcla el resumen ni la sugerencia de otro archivo y se vacía al cerrar el último.
- **Resumen del archivo.** El tutor recibe una línea «Dependencias del archivo» (lo que usa del proyecto, las bibliotecas y quién lo usa) para explicar qué papel tiene el archivo en el proyecto. No lleva lo no encontrado: eso solo lo confirma la búsqueda en el disco, y el tutor podría decir que falta un archivo que existe.
- **Índice del proyecto** (`workspace-index.ts`):
  - Lee cada archivo de sus bytes (o del editor si está abierto, con lo no guardado) en vez de abrirlo con `openTextDocument`, que hacía que las extensiones de C/C++ y Python analizaran hasta 90 archivos.
  - No incluye archivos de claves (`.env`, `credentials.json`, `*.pem`…), igual que el escaneo.
  - La estructura de los archivos relacionados que viaja al tutor no lleva líneas con claves ni el valor de las constantes con nombre de clave (`API_KEY = "…"`, `scrubOutline` en `scan-privacy.ts`).
  - Se rearma al crear o borrar archivos (también desde la terminal o con git) y al cambiar `adaceen.scan.*`; un índice que se armaba mientras se guardaba un archivo ya no queda en la caché un minuto.
- **Revisión independiente antes de publicar** (otro agente, con el código compilado, un VS Code simulado y casos adversos). Encontró, y quedó corregido con pruebas:
  - La limpieza de claves de la estructura usaba una expresión regular que, con una línea larga llena de `\` y la cadena cortada, tardaba minutos y congelaba VS Code en cada guardado. Ahora es lineal, enmascara cada `clave = "..."` de la línea (también argumentos por defecto) y las cadenas que el recorte deja abiertas.
  - Los paquetes de un virtualenv (`.venv/…/site-packages/numpy`) salían como archivos «de tu proyecto» y con el aviso de «tapa el módulo». El índice y el escaneo ya no leen `.venv`, `venv`, `site-packages`, `.tox`, `.gradle` ni las cachés de Python.
  - Un `#include` o `import` de un archivo que solo está en otra carpeta salía como encontrado (justo el error que el cuadro debe mostrar). Ahora va a «No encontradas» con «Está en «taller1/figura.h»: escribe #include "../taller1/figura.h"»: el compilador busca junto al archivo y en `include/`; Python, junto al archivo, en la raíz y en `src/`. Un `.h` de una carpeta de arriba se encuentra con aviso, y en Ruby `require` de un archivo de al lado pide `require_relative`.
  - La búsqueda en el disco mira primero donde debería estar el archivo; antes traía 5 al azar y podía elegir el de otra carpeta.
  - Con varias carpetas abiertas, cada archivo se compara solo con los de su carpeta (un clic abría el de la otra y «La usan» repetía archivos).
  - JS: un `import` o `require` dentro de una cadena, una plantilla o una expresión regular ya no cuenta, y una expresión regular con `/` o comillas ya no esconde los imports de abajo. C/C++: `#if 0`, cadenas crudas `R"(…)"`, comentarios que siguen con `\` y separadores de dígitos. Python: un `;` dentro de una cadena no parte la línea. Java y C#: todos los imports de una línea. `./util` sin extensión ya no es `util.css`, y la sugerencia de un `.h` no apunta a un `.cpp`.
  - Cambiar el lenguaje de un archivo (un `.tpp` marcado como C++) ya no vacía la vista; un clic en un cuadro que cambió mientras tanto no abre otra cosa; un resultado del texto viejo ya no queda guardado con la versión nueva; el autoguardado no rearma el índice a cada segundo (guardar el archivo que se ve no cambia quién lo usa).
  - Archivos en Windows-1252 (Dev-C++, Bloc de notas) se leen sin «�», en el índice y en el escaneo. Un paquete de Java en otra carpeta de fuentes (`src/test/java`) y los espacios de nombres anidados de C# se reconocen.
- **Segunda revisión independiente** (otro agente, con la extensión real en un VS Code simulado y con proyectos como los del piloto). Encontró, y quedó corregido con pruebas:
  - Un clic en «Usa de tu proyecto» no abría nada si el import tenía carpeta (`#include "modelo/figura.h"` se ve como «figura.h»): se buscaba por el texto que se ve. Ahora el clic lleva un identificador del elemento.
  - «La usan» no cambiaba al volver a un `.h` después de agregar su `#include` en otro archivo y guardarlo, y cambiar el lenguaje de un archivo (un `.tpp` a C++) no volvía a calcular el cuadro.
  - C++ con CMake, como en la VM del piloto: una prueba en `test/` que incluye `"Calculadora.h"` de `src/` salía «No encontrada», y también `gtest/gtest.h`, `gmock/gmock.h` y `json.hpp`, que están instalados. Ahora un `.h` del mismo proyecto cuenta como encontrado si hay `CMakeLists.txt` o `Makefile`; sin ellos, uno de otra carpeta del mismo ejercicio se encuentra con el aviso «compila con -Iheaders o escribe #include "../headers/lista.h"». GoogleTest, nlohmann/json, Catch2, Boost, SFML y otras van a «Bibliotecas».
  - Python ejecutado desde una carpeta de arriba (`python -m app.main`, `tests/`, un proyecto Django en `backend/`): sus módulos salían «No encontrados». Java con Gradle o Maven: como `build.gradle` y `pom.xml` no están en el índice, una dependencia externa salía «No encontrada».
  - JS: plantillas anidadas (`${a(`${b}/${c}`)}`) y el `</p>` de JSX escondían los imports de esa línea; los alias `~/` y de `tsconfig` (`@components/Boton`) salían como paquetes de npm; `./App` con `App.vue` (con el aviso de Vite) y `./tipos` con `tipos.d.ts` se encuentran. Ruby: `spec_helper` y `lib/` de RSpec.
  - Un `.py` de `.venv` abierto con F12 se comparaba con el proyecto: ahora, como un archivo de afuera, solo muestra sus bibliotecas y no va en la línea del tutor. `#include "modelo/"` a medio escribir ya no cuenta como encontrado (era la carpeta).
  - Un archivo UTF-8 con un solo byte de otra codificación se leía entero como Windows-1252 («Ã±» en vez de «ñ»). Una dirección con usuario y clave (`mysql://root:clave@host`) en la estructura ya no viaja al tutor.
  - La carpeta `env/` se vuelve a leer (puede ser código del estudiante); un virtualenv con ese nombre se reconoce por su `site-packages`.
- **Tercera revisión independiente** (dos agentes más: uno con la lectura de los imports, comparada con g++, el `ast` de Python y el compilador de TypeScript; otro con la extensión real en un VS Code simulado y la vista en un navegador simulado). Encontró, y quedó corregido con pruebas:
  - Un `.py` guardado en Windows (fin de línea `\r\n`) no mostraba ningún import, y en C++ un `#if 0` así tampoco se reconocía.
  - C++: el ejercicio es la carpeta del archivo (o la de arriba de `src/`, `test/` o `include/`), y `semana3/taller2/main.cpp` ya no «encuentra» el `figura.h` de `semana3/taller1`. Un `#include <Calculadora.h>` de tu proyecto con CMake es tuyo (con el aviso de comillas) y cuenta en «La usan»; `include/` sin CMake ni Makefile también pide el `-Iinclude`; con dos copias se abre la de `src/` o `include/` y no la de `old/`. `windows.h` y `conio.h` dentro de `#ifdef _WIN32` ya no llevan el aviso de Linux. Avisos más precisos: la carpeta escrita con otra mayúscula, `"../figura.h"` con el archivo al lado, `stdafx.h` de Visual Studio y un archivo que se incluye a sí mismo; un `Lista.tpp` que falta ya no sugiere el mismo `Lista.h`.
  - Python: `from modelo import figura, cuadrado` (con `__init__.py`) abría el `__init__.py`; ahora son sus módulos, también en «La usan». `time.py` no tapa a `time` (Python usa el suyo) y con `math.py` depende del equipo: el aviso lo dice. `keyboard`, `psutil` o `tkcalendar` salían como errores de tipeo, y `reqeusts` o `numpi` como «instálalo con pip» (un paquete con ese nombre puede ser malicioso): ahora se comparan con los paquetes conocidos («¿Quisiste decir «requests»?»). Una línea `from` con miles de puntos tardaba segundos.
  - Los nombres con tildes (`import geometría`, `class Canción`) se perdían. Java: un enum dentro de una clase (`import modelo.Carta.Palo;`), un `pom.xml` solo vale para su carpeta, y en un proyecto Maven grande una clase tuya se busca en el disco antes de llamarla dependencia. JS: `./usuario.routes` (no es una extensión) y `components/Boton` con `baseUrl`. Un bloque de texto de Java, una cadena `@"..."` de C# o un heredoc de Ruby ya no traen imports, y lo de `_deps` (FetchContent de CMake) no es «tuyo».
  - «La usan» no se enteraba de los cambios hechos fuera de VS Code (git pull, otro editor); un archivo creado mientras se buscaba quedaba «sin encontrar»; con una carpeta del proyecto abierta dentro de otra los archivos se mezclaban; y un archivo nuevo sin título (Ctrl+N) no se seguía. Las búsquedas en el disco ya no se repiten cada 30 s mientras se escribe. La vista ya no se vuelve a pintar si nada cambió: el foco del teclado se queda donde estaba, el resaltado del comando no se pierde y el lector de pantalla solo anuncia el cuadro de otro archivo. El código de un paquete instalado tiene su propia nota.
  - La extensión web no cargaba en un Safari anterior a 16.4 (expresiones regulares con lookbehind). `redis://:clave@host`, `pwd = "…"` y la clave de una cadena de conexión (`Password=…;`, `&password=…`) ya no viajan al tutor. Un archivo en Windows-1252 con un par UTF-8 por casualidad ya no se lee como UTF-8, y sus comillas curvas salen bien también en VS Code de escritorio.
  - El índice incluye también `.cc`, `.hh`, `.tpp`, `.vue` y `.svelte` (valor por defecto de `adaceen.scan.includeGlob`) y no lee `_deps`.
- 87 pruebas unitarias nuevas (338 en total).

### Compatibilidad

- Con el backend anterior, la línea «Dependencias del archivo» queda pegada a la parte anterior del contexto y se recorta como antes. El backend del 25 de octubre la reconoce y, si el prompt no cabe, la quita después del mapa del proyecto.

## [0.0.35] - 2026-10-21

Revisión de precisión del tutor, con técnicas de otros asistentes de código y tutores de programación (SWE-agent, Aider, Continue, Roo Code, OpenHands, CodeHelp, Iris). Va con el backend del mismo día.

### Cambiado

- **El tutor ve el código donde está el estudiante.** Antes se mandaban los primeros 7200 caracteres del archivo (aunque el cursor estuviera en la línea 300), el texto visible repetido y un mapa de 24 archivos con vista previa. Ahora van unas 100 líneas numeradas alrededor de la selección o del cursor, con «>» en las líneas del foco (como el visor de archivos de SWE-agent, que rindió más que 30 líneas o el archivo entero), la estructura del resto del archivo (clases y funciones con su número de línea, como el mapa del repositorio de Aider), las declaraciones de los archivos relacionados (el `.h` del `.cpp`, lo que incluye o importa, las clases que usa) y la lista corta de los demás archivos (`prompt-context.ts`). Un archivo corto va entero.
- **La pregunta dice qué pide el estudiante, no el formato.** El backend pone el formato, el límite del docente y las reglas del código al final del prompt; antes la pregunta repetía esas reglas con otras palabras.
- **Sangría al aplicar.** Al reemplazar, el código se re-indenta a la sangría del bloque con la unidad del editor (tabuladores o N espacios): se quita la sangría común, se convierten los niveles y se pone la del bloque. Al insertar, el código sin sangría va a la del lugar (un nivel más si la línea de arriba abre un bloque); el que trae sangría propia se respeta en Python cuando es válida en ese punto (la sangría decide el bloque: un `return` escrito al nivel de la función no se mete en el ciclo de arriba, y el código de nivel superior al final del archivo queda al margen), y en los lenguajes con llaves va a la sangría del lugar. Antes solo se tocaba si la primera línea venía sin sangría: un bloque con 4 espacios en un archivo con 2 quedaba descuadrado (`code-reindent.ts`).
- **Los «...» del modelo ya no borran líneas.** Si la versión mejorada resume con `// ...` o `// resto igual` las líneas que no cambian, se completan con las del bloque original solo cuando no hay duda de cuáles son: la línea de justo antes del resumen tiene que estar igual en el original y la de después tiene que aparecer una sola vez; las líneas traídas toman la sangría del modelo. La ventana lo avisa. Si no se cumple, no se ofrece aplicarla con un clic y se pide otra vez (como Aider con sus `...` y Continue con `// ... existing code ...`).
- **Llaves sin cerrar.** Una versión del bloque que deja llaves o paréntesis sin cerrar (sin contar los de cadenas y comentarios) no se aplica con un clic si el bloque original estaba completo: rompería el archivo (como el linter que SWE-agent corre antes de aceptar una edición). Al insertar, solo se avisa.
- Si el modelo copia el margen numerado del contexto («16| …»), se quita antes de decidir la acción (con el margen, un bloque completo pasaba por fragmento para insertar y un `// TODO` por código).
- El recorte del archivo para el prompt va centrado en el foco con el mismo tope (`adaceen.suggestions.maxCodeChars`): en un archivo largo el cursor de la línea 900 ya no queda fuera; la última línea vacía cuenta (el cursor tras el último Enter se marca bien).
- Revisión independiente antes de publicar, en dos vueltas: encontró que la primera versión del re-indentado metía en el ciclo un `return` de Python, que el completado de «...» podía volver a poner la línea que el modelo había cambiado o saltarse líneas repetidas, que la ventana marcaba mal el foco al final del archivo y, en la segunda vuelta, que una línea alineada bajo un paréntesis doblaba la sangría de las líneas traídas; todo corregido y con pruebas. Además: en Python, el código sin sangría que se inserta en una línea vacía dentro de un bloque toma la sangría de la línea de abajo (antes quedaba al margen y rompía el bloque), y «cambio una línea de un `if`, cierro con `}` y resumo el resto» ya se completa.
- 37 pruebas unitarias nuevas (251 en total).

### Compatibilidad

- Con el backend anterior al 21 de octubre funciona igual: el contexto nuevo es texto y sus encabezados son los mismos o nuevos (el backend viejo los corta a ciegas como antes).

## [0.0.34] - 2026-10-20

Piloto del 20 de octubre (prueba con una estudiante): «cuando ADACEEN sugiere código, lo único es agregar un TODO», «la mejora de código no está sirviendo bien» y «el panel con el resumen de la pestaña y el atajo al material del curso ya no están».

### Cambiado

- **Nunca un `TODO` inventado.** La pista local y la respuesta del tutor sin bloque de código ya no se convierten en un comentario `// TODO: …` para insertar. El código sale solo del bloque que escribió el tutor (`suggestion-code.ts`); un bloque de puros comentarios o marcadores no cuenta como código. Si no hay código, la ventana lo dice y ofrece pedirlo.
- **Cada acción con su propio código.** La ventana de la selección («Sugerencia para la selección») aplica con un clic solo la acción para la que el tutor escribió el código («Insertar debajo» o «Modificar selección») y trae «Ver cambios», que abre la comparación (`vscode.diff`) antes de aplicar. «Proponer una mejora» pide al backend la selección completa mejorada (`requestedAction: "replace"`) y «Proponer código para continuar», el código para insertar debajo (`"insert"`); la respuesta aparece en la misma ventana. Antes, «Modificar selección» reemplazaba el bloque por un fragmento escrito para insertar. Si la versión mejorada se lleva más de la mitad del bloque, la ventana avisa que la revises con «Ver cambios».
- **Vista «ADACEEN · Este archivo»** en el Explorador (`adaceen.fileView`): «De qué trata» (resumen del tutor, con «Pedir resumen al tutor» / «Actualizar resumen»), «Para seguir», «Sugerencia de ahora» y «Material del curso» (lo citado en la última sugerencia y «Ver todo el material del curso», con búsqueda). El clic en «ADACEEN: <archivo>» de la barra de estado la abre. Comandos nuevos: «ADACEEN: Ver de qué trata el archivo y el material del curso», «ADACEEN: Ver material del curso» y «ADACEEN: Ver cambios de la propuesta».
- **Cuando la GPU tarda.** A los 20 s sin respuesta, la ventana dice «El tutor está tardando más de lo normal…» en vez de quedarse cargando sin explicación.
- **Modo restringido.** La extensión declara `untrustedWorkspaces: limited`: en una carpeta no confiable sigue con las sugerencias, el resumen y el quiz (antes VS Code la desactivaba), sin tomar de esa carpeta la dirección del backend, la clave del worker, la sesión ni los ajustes de aplicar código.
- «Ver panel» (llevaba al quiz) pasa a «Resumen y material»; «Otra sugerencia» actualiza la ventana en su sitio sin abrir el quiz.
- Textos con tildes: «Modificar selección», «Eliminar selección».
- **Aplicar va sobre el bloque que vio el tutor** (revisión independiente del mismo día): con más de 20 líneas seleccionadas el tutor solo ve las primeras 20, y «Modificar selección» ya no borra las demás; un clic dentro del bloque (selección vacía) ya no hace que el bloque entero reemplace una sola línea. Si el bloque cambió desde la sugerencia, no se aplica y se pide «Otra sugerencia».
- **Cuando el modelo se equivoca de acción** (dice «Aplicar: insert» con el bloque completo, «replace» con un fragmento o «delete» con código cuando se pidió mejorar), decide el contenido: si el código conserva la mitad o más de las líneas del bloque (sin contar llaves ni palabras sueltas como `else`) es una versión del bloque; si no, un fragmento para insertar. El backend usa la misma regla. El aviso de «Ver cambios» sale desde bloques de 2 líneas (antes, 4).
- Pedir el código no congela las sugerencias: mientras llega, el estudiante puede ir a otro bloque, y si se fue (o cerró la ventana) la respuesta no se pinta sobre las líneas viejas; se muestra si vuelve al mismo bloque.
- «Otra sugerencia» y «Proponer una mejora» le preguntan otra vez al tutor (no repiten la respuesta guardada), y no se guardan la respuesta sin modelo ni un pedido de código que volvió sin código.
- Una respuesta que es solo la línea «Aplicar:» y el bloque de código ya no se descarta; si el tutor contestó sin nada utilizable, la pista local sale de una vez en vez de esperar el tiempo límite.
- 23 pruebas unitarias nuevas (214 en total).

### Compatibilidad

- Con el backend del 20 de octubre, el modelo recibe la acción pedida y el lenguaje, no se le pide `TODO` y la regla del docente cuenta las líneas que cambian (no recorta una versión completa del bloque). Con el backend anterior la ventana funciona igual, pero «Proponer una mejora» puede volver sin código.
- La VM de editores instala la VSIX que fija el submódulo: se publica con `git add -f adaceen-0.0.34.vsix`.

## [0.0.33] - 2026-09-28

Riesgos antes del piloto (revisión técnica del 27 de septiembre; A12.12 · ADACEEN-155 de PDC).

### Cambiado

- **Cola de reemplazos del navegador con lease.** VS Code reclama con `POST /api/projects/code-actions/claim` y recibe un lease de 180 s; con un backend anterior usa `GET /api/projects/code-actions/next`. El aviso «Aplicar reemplazo» / «Omitir» se da por no respondido a los 2 minutos: antes, si el estudiante lo ignoraba, la cola se quedaba parada. Un cambio ya aplicado se confirma con reintentos (un 404 es que ya estaba cerrado) y nunca se reporta como fallido: antes un fallo de `complete` terminaba en `fail` y la tesis contaba un dato falso. Un reemplazo que volvió a la cola porque su primer reclamo venció no se aplica dos veces si el archivo ya tiene el cambio (`src/code-action-queue.ts`).
- **Escaneo pedido desde el navegador con permiso.** Antes de enviar nada, VS Code pregunta cada vez: «Permitir», «Permitir siempre en este repo» (se recuerda en el workspace) o «No»; sin respuesta en 2 minutos no se envía y el backend recibe el fallo. El escaneo ya no incluye lo que ignora `.gitignore` (`git ls-files --exclude-standard`), ni archivos con claves (`.env`, `.pem`, `.key`, `credentials.json`, `client_secret*.json`, carpetas `.ssh` o `.aws`, llaves privadas y tokens con prefijo conocido en cualquier archivo, y asignaciones de contraseñas en archivos de configuración), y se detiene en 3 MB (`src/scan-privacy.ts`). El resultado dice cuántos archivos se omitieron por cada motivo. Los archivos se leen de sus bytes, sin `openTextDocument`, que despertaba los servidores de lenguaje.
- **Con la sesión.** Reclamar un escaneo, enviarlo, reportar un fallo y clasificar documentos van con la sesión: el backend solo entrega las solicitudes del mismo estudiante.
- **Sin robar el foco.** Los errores del worker se registran en «ADACEEN» sin abrir el panel de salida.
- 16 pruebas unitarias nuevas (191 en total).

### Compatibilidad

- Con el backend anterior: los reemplazos siguen funcionando (`GET …/next`) y el escaneo también (el backend viejo no pide sesión).
- Con el backend del 28 de septiembre, la 0.0.32 ya no recibe solicitudes de escaneo (las reclamaba sin sesión); los reemplazos sí.
- La VM de editores instala la VSIX que fija el submódulo: se publica con `git add -f adaceen-0.0.33.vsix` (`*.vsix` está en `.gitignore`).

## [0.0.32] - 2026-09-25

Menos pasos repetidos (auditoría de redundancias del frontend, ítems 6, 7 y 13).

### Cambiado

- **El clic explícito del estudiante cumple `requireConfirmation` en los cambios pequeños.** La política del docente (`POST /api/suggestions/apply-check`) puede pedir confirmación antes de aplicar código del tutor (`requireConfirmation: true`, el valor por defecto). Desde esta versión, en un cambio de hasta 5 líneas que no borra código (`CLICK_CONFIRM_MAX_LINES`), esa confirmación es el clic del estudiante sobre la acción concreta: «Insertar debajo» o «Modificar seleccion» de la ventana flotante, «Aceptar ayuda» del CodeLens, de la pista en línea o del hover, el arreglo rápido que el estudiante abre con `Ctrl+.`, «ADACEEN: Aplicar sugerencia activa» o un reemplazo que acaba de elegir en el overlay del navegador. Ya no se abre después el modal «ADACEEN: ¿Aplicar el cambio del tutor…?» con «Aplicar», que solo repetía la pregunta. El modal sigue para las aplicaciones automáticas (las que nadie pulsó), para los cambios de más de 5 líneas y para las eliminaciones, aunque haya clic: un clic sin querer en un CodeLens no reescribe ni borra un bloque sin una pausa, y el detalle dice por qué pregunta. El menú de arreglos rápidos que ADACEEN abre solo (`adaceen.suggestions.autoOpenSelectionActions` sin ventana flotante) no cuenta como clic: su acción viene preseleccionada y un Enter la aplicaría. La política se respeta igual: si el docente no permite aplicar (`allowed: false`: aplicación desactivada, cambio demasiado largo o cupo agotado), no se aplica y se muestra el motivo; sin conexión sigue la regla de `adaceen.codeApplication.offlineMaxLines`. El veredicto y las métricas locales dicen cómo se confirmó (`confirmedBy: click | dialog`).
- **Reemplazos elegidos en el overlay:** se aplican sin el segundo aviso «Aplicar reemplazo» / «Omitir» cuando el clic en el overlay es reciente (10 minutos o menos en la cola, con la hora del servidor) y VS Code encuentra el cambio donde el estudiante lo vio: el código elegido aparece una sola vez en el archivo (o varias, pero una toca el cursor o la selección, y se usa esa en lugar de la primera del archivo) o, al insertar, la línea enfocada sigue en su sitio. Si no (el estudiante editó esa parte, el código aparece varias veces lejos del cursor, esperó más de 10 minutos porque VS Code estaba cerrado o falta la hora en que se pidió), pregunta como antes y dice qué es, hace cuánto se pidió y dónde caerá («No encontré en Main.java el código que elegiste (cambió o ya no está): se aplicará en la línea 14.»): el diálogo del docente si su política pide confirmar o, si no, «Aplicar reemplazo» / «Omitir» (salvo `adaceen.backend.autoApplyCodeActions`). El cambio se aplica en el sitio anunciado aunque el estudiante mueva el cursor mientras decide. «ADACEEN: Aplicar siguiente reemplazo del navegador», ejecutado a mano, no cuenta como clic: aplica el más antiguo de la cola, que el estudiante no ve. La métrica de la cola guarda `confirmedBy` (`click`, `dialog` o `auto`) y `targetVerified`.
- **Una sola superficie con «Aceptar ayuda» a la vez.** Mientras la ventana flotante está abierta sobre la selección, el CodeLens no agrega «Aceptar ayuda: …» (el resumen «ADACEEN: …» se queda, así la línea no salta) y la pista en línea y la decoración de fin de línea se apagan; antes volvían a aparecer con cualquier movimiento del cursor. Vuelven cuando la ventana se retira porque el estudiante movió la selección (`src/suggestion-surfaces.ts`). Si la cerró con la X, esa sugerencia quedó descartada y no se vuelve a ofrecer en el CodeLens ni en la pista hasta que llegue otra. Con los comentarios del editor ocultos (`comments.visible: false`) la ventana no se ve y el CodeLens y la pista siguen ofreciendo la acción. El arreglo rápido (`Ctrl+.`) sigue disponible. Límite conocido: si el estudiante pliega la ventana con su flecha, VS Code no avisa a la extensión; la ventana se vuelve a abrir con su icono del margen.
- **«ADACEEN: Conectar»:** una sola opción para escribir o pegar, «Tengo un código o sesión», que acepta el código `XXXX-XXXX` del navegador o el ID de sesión de versiones anteriores. Reemplaza a «Tengo un código del navegador» y «Pegar sesión», y su detalle ya no dice que el overlay copia el ID de sesión (copia un código).
- **Cuentas de docente con GitHub:** el aviso ya no repite el texto del backend, que citaba «Copiar sesion» y «Tengo un codigo del navegador». VS Code muestra su propio texto (mismo comienzo, «Las cuentas de docente y administrador se vinculan con un codigo del navegador»), que nombra «Copiar codigo para VS Code» y «Tengo un código o sesión», y en lugar de «Reintentar» (que fallaría igual) ofrece el botón «Tengo un código o sesión», que abre la caja del código.
- **«ADACEEN: Configurar sesión compartida»** sigue en la paleta por compatibilidad: el overlay lo cita con un backend sin emparejamiento y las versiones anteriores del navegador mandan a buscarlo con F1. Abre la misma caja que «Tengo un código o sesión» y avisa lo mismo al conectar.
- **Aviso de sesión perdida:** nombra el botón que ofrece. Dice «Pulsa «Conectar»…» y, en el túnel, también «…o vuelve a pulsar «Abrir mi editor» en el navegador». Antes solo mandaba al navegador y el botón decía otra cosa. Con un backend sin la ruta de canje, el mensaje manda a «Tengo un código o sesión» en lugar de «Pegar sesión».
- 39 pruebas unitarias nuevas (175 en total): clic explícito frente a `requireConfirmation` (cambio pequeño, grande y eliminación), política que no permite aplicar, regla offline con clic, menú de arreglos rápidos abierto solo, antigüedad de los reemplazos del overlay (sin hora se pregunta), destino comprobado de los reemplazos (coincidencia única, ninguna, varias e inserción) y el aviso que dice dónde caerán, opciones de «ADACEEN: Conectar», aviso para docentes, aviso de sesión perdida, ventana flotante frente a CodeLens y pista en línea (descartada con la X y comentarios ocultos) y el comando heredado en la paleta.

### Compatibilidad

- Sin cambios de contrato con el backend: `apply-check` responde igual y la cola de reemplazos ya devolvía `source`, `requestedAt` y `claimedAt`. Un reemplazo sin `requestedAt` se pregunta (no se puede saber si el clic es reciente). El aviso para docentes usa el campo `reason: staff_requires_code` que el backend ya manda.
- Con el navegador 0.7.12 de la misma rama de PDC: el overlay manda a «Tengo un código o sesión» al copiar el código para VS Code y dice que VS Code aplica el reemplazo elegido en unos segundos. El backend de esa rama, en el aviso que solo muestran tal cual las versiones 0.0.31 y anteriores, nombra «Copiar codigo para VS Code» (el botón del navegador 0.7.12) y conserva «Tengo un codigo del navegador», la opción que esas versiones tienen.
- La VM de editores instala la VSIX que fija el submódulo: se publica con `git add -f adaceen-0.0.32.vsix` (`*.vsix` está en `.gitignore`). Si falta, la VM conserva la 0.0.31, que sigue funcionando con el túnel.

## [0.0.31] - 2026-09-25

Acceso simplificado (contrato `docs/arquitectura/acceso-simplificado.md` de PDC, sección 3): el estudiante ya no copia ni pega la sesión.

### Añadido

- La sesión de ADACEEN se resuelve en este orden (`src/editor-session.ts`): 1) la sesión emparejada en este equipo, guardada en el llavero de VS Code (SecretStorage `adaceen.editorSession`, nunca en settings); 2) `~/.adaceen/editor-session.json`, que escribe la VM de editores al preparar el túnel (cero clics; se relee al arrancar, al volver a la ventana, cuando el archivo cambia y cuando el backend rechaza la sesión; en la extensión web no se lee); 3) el ajuste heredado `adaceen.backend.sessionId` y `ADACEEN_SESSION_ID`. Todas las llamadas (sugerencias, métricas, apply-check, cola del navegador, rack, quiz y el visor de fuentes RAG) usan la sesión resuelta.
- La sesión emparejada solo se usa con el backend donde se obtuvo: no viaja al backend local de la Mac ni a un `adaceen.backend.baseUrl` que traiga un repositorio, y vuelve a valer sola al volver a su backend. En el túnel, un `editor-session.json` escrito después de guardar la sesión emparejada gana (la VM es del estudiante; el llavero de vscode.dev puede ser de un perfil compartido).
- Sin sesión, al arrancar se intenta en silencio la cuenta de GitHub que VS Code ya tiene (`read:user`) y se canjea en `POST /api/auth/editor/github`: cero clics cuando la extensión ya tenía permiso. El token de GitHub no se guarda ni se registra. No se hace si en este equipo se cerró sesión o se desconectó VS Code (marca en `globalState` que quita la siguiente conexión hecha a mano), si `adaceen.backend.baseUrl` lo fija el espacio de trabajo abierto, ni pisa una conexión que termine antes (enlace, código o archivo del túnel).
- Barra de estado «ADACEEN: sin conectar» / «ADACEEN: <nombre>» y comando **ADACEEN: Conectar** con tres opciones: «Con mi cuenta de GitHub (recomendado)» (un clic en «Permitir»), «Tengo un código del navegador» (`XXXX-XXXX`, canje en `POST /api/auth/editor/claim`; también acepta el UUID de antes) y «Pegar sesión».
- Cuando el backend responde `x-adaceen-session: invalid` (por ejemplo, cerraste sesión en el navegador): se olvida esa sesión, se relee el archivo del túnel y, si no queda otra, una sola advertencia por ventana con el botón «Conectar» (en el túnel sugiere volver a «Abrir mi editor»). No se vuelve a conectar en silencio con GitHub: en una Mac compartida esa cuenta puede ser de otro estudiante. Al arrancar, la sesión que hay se comprueba con `GET /api/auth/me` (así también se detectan sesiones muertas en un backend anterior y se muestra el nombre). Una sesión que vence con la ventana abierta se detecta en la revisión de cada 20 s (barra y advertencia). Si el llavero de VS Code tarda más de 3 s, la sesión guardada se aplica cuando conteste y el arranque la espera antes de probar GitHub.
- «ADACEEN: Conectar» ofrece «Desconectar este equipo» cuando hay sesión guardada. Si un enlace del navegador reemplaza la sesión de otra persona, el aviso lo dice («¿No eres tú?») con el botón «Desconectar».
- Enlaces del navegador para VS Code de escritorio (Mac del laboratorio): `vscode://adaceen.adaceen/abrir?code=XXXX-XXXX&repo=owner/repo` y `vscode://adaceen.adaceen/conectar?code=XXXX-XXXX`. El código se canjea contra el backend ya resuelto por la extensión (un parámetro `backend` distinto se ignora). Con `repo`, abre la carpeta recordada si ya se clonó en este equipo o pide la carpeta padre, clona `https://github.com/<owner>/<repo>.git` y la abre; si falta git, lo explica y ofrece el comando de instalación (`xcode-select --install` en la Mac). Nueva activación `onUri`. Los enlaces se atienden de a uno y, si llega otro mientras tanto (doble clic: cada clic pide un código nuevo e invalida el anterior), se atiende el último en vez de descartarlo; los avisos que no bloquean (falta git, carpeta ocupada) ya no retienen los enlaces siguientes.
- 66 pruebas unitarias nuevas (136 en total): archivo de sesión (versión, campos, vencida), códigos y UUID, orden de resolución y reacción a sesiones inválidas con dependencias falsas, carreras entre GitHub en silencio y el enlace, llavero lento, vencimiento con la ventana abierta, «Desconectar», canjes, cola de enlaces, visor RAG y cabecera `x-adaceen-session`.

### Cambiado

- «ADACEEN: Configurar sesión compartida» sigue existiendo: ahora acepta un código `XXXX-XXXX` (lo canjea) o el UUID de antes, y guarda la sesión en el llavero de VS Code en lugar de `adaceen.backend.sessionId`.
- El backend sigue eligiéndose como en la 0.0.30 (`src/backend-url.ts`); la detección del backend local termina antes de leer la sesión guardada.
- El enlace al visor de fuentes RAG ya no lleva `sessionId` en la URL (el visor no la usa y quedaba en el historial del navegador, en los logs de acceso y en la métrica `vscode_rag_source_opened`); también se quita si viene del backend.

### Compatibilidad

- El canje con código o con GitHub y la cabecera `x-adaceen-session` requieren el backend de la rama `claude/serene-heisenberg-0te9s9` de PDC. Con un backend anterior, «Pegar sesión» y el ajuste heredado funcionan como antes, y una sesión muerta se detecta igual por el 401 de `/api/auth/me`.

## [0.0.30] - 2026-09-24

### Cambiado

- Backend por defecto (Mac del laboratorio y VS Code instalado en cualquier equipo): la conexión local de siempre se conserva. Si en el equipo corre un backend de ADACEEN (`npm run dev:local` o el rol local de las Mac del laboratorio), la extensión lo usa en `http://127.0.0.1:3000`, igual que antes. Si no hay backend local, usa producción, así que VS Code instalado en las Mac del laboratorio o en Windows funciona sin configurar nada. Se reconoce el backend local por su `GET /health` (`ok`, `mode` y `database_provider`), para no confundirlo con otra aplicación del estudiante en el puerto 3000. La prueba se hace al activar (máximo 800 ms) y cada 30 s, así que encender o apagar el backend local cambia el destino sin reiniciar VS Code. Un valor escrito en `adaceen.backend.baseUrl` o en `ADACEEN_BACKEND_URL` sigue mandando, y Codespaces sigue en producción (`src/backend-url.ts`). En vscode.dev sin túnel (extensión web) no se prueba el equipo, para que el navegador no pida permiso de red local: va a producción.
- El valor por defecto de `adaceen.backend.baseUrl` pasa a vacío. Quien ya lo tenía escrito, por ejemplo `http://127.0.0.1:3000` o la URL de la VM de editores que fija `nuevo-tunel.sh`, conserva ese valor.

### Añadido

- Telemetría: cada evento lleva `metadata.editorHost` (`local`, `tunnel`, `codespaces` o `remote`) y `metadata.editorUi` (`desktop` o `web`). Así el piloto puede separar VS Code instalado en las Mac del laboratorio de vscode.dev por túnel.
- Indicador de GPU: el tooltip lista los servidores de inferencia con latido reciente (por ejemplo «Mac del laboratorio - M2 x2, Google Cloud - V100») y de dónde salió la URL del backend.
- El canal ADACEEN registra el backend elegido y cada cambio (`[Backend] …`).
- 11 pruebas unitarias nuevas (70 en total).

### Compatibilidad

- `editorHost` y `editorUi` solo se guardan con un backend que los tenga en su lista blanca de metadata (rama `feat/macs-laboratorio` de PDC). Un backend anterior descarta esas claves y guarda el resto del evento.

## [0.0.29] - 2026-09-24

### Añadido

- Fin de los episodios de bloqueo (A3.3 ADACEEN-43, base del KPI P1): nuevo evento `blocking_resolved` cuando desaparece del archivo el error que causó un bloqueo. `durationMs` es el tiempo hasta desbloqueo (desde que apareció el error hasta que desapareció) y la metadata lleva `line`, `blockedForMs` (desde la señal de bloqueo), `resolvedWhileAway` y `errorCount`. Si el error se corrigió mientras el estudiante estaba en otro archivo, el episodio se cierra al volver, pasado el tiempo de estabilidad de los diagnósticos, con `resolvedWhileAway: true` (el tiempo es una cota superior). Si vuelve a un archivo con el error todavía presente, sigue el mismo episodio. Los episodios que no se cierran no emiten nada (en el análisis quedan censurados). Se recuerdan hasta 50 episodios abiertos.
- El canal ADACEEN registra cada desbloqueo (`[Signals] Desbloqueo en …`).
- 5 pruebas unitarias nuevas de episodios (59 en total).

### Compatibilidad

- Requiere un backend que acepte `blocking_resolved` y las claves `blockedForMs` y `resolvedWhileAway` (rama `feat/segunda-tanda-jira` de PDC). Un backend anterior guarda el evento, pero descarta de la metadata las claves que no conoce.

## [0.0.28] - 2026-09-24

### Añadido

- Identidad unificada: todas las llamadas al backend (sugerencias, métricas, apply-check, indicador de GPU, worker y quiz) envían `x-adaceen-client-id` con el id persistente que ya usaba la vista de quiz, además de `x-session-id` cuando hay sesión compartida (`src/client-identity.ts`).
- Telemetría v1.1 (A11.2 ADACEEN-98, A4.2): los eventos se envían también sin sesión e incluyen `schemaVersion: "1.1"`, `seq`, `clientSessionId`, `decisionId` y `latencyMs`; un reintento ante error de red; los eventos casi simultáneos viajan en un solo POST. Nuevo evento `vscode_suggestion_ignored` con el tiempo que la sugerencia estuvo a la vista.
- Señales de error y bloqueo (A6.2 ADACEEN-63): `compile_error_detected` y `blocking_detected` a partir de los diagnósticos del archivo activo. Un bloqueo (mismo error ≥ `adaceen.triggers.blockingSeconds` o 3 veces en 10 minutos) puede pedir una sugerencia con `trigger: "blocking"`.
- `/suggest-tab` (A9.10 ADACEEN-144): la petición envía `trigger`, `visibleError`, `diagnostics` y `clientSessionId`; la respuesta guarda `decision_id`, `policy_applied` y `code_application`. Las respuestas bloqueadas por la política se muestran como mensaje del tutor, sin acciones de aplicar código (`vscode_suggestion_blocked_by_policy`), y se muestra cuántas aplicaciones quedan en el archivo.
- Límite de aplicación de código (A10.8 ADACEEN-145): antes de aplicar cualquier cambio del tutor (ventana flotante, CodeLens, quick fix, panel y reemplazos del navegador) se consulta `POST /api/suggestions/apply-check`; se respeta `allowed`, `requireConfirmation` y, sin red, `adaceen.codeApplication.offlineMaxLines` (`src/code-application-guard.ts`). Evento `code_application_blocked`; `suggestion_completion_applied` lleva `decisionId` y `metadata.linesChanged`.
- Indicador de GPU (A15.4 ADACEEN-125): con backends que informan latidos, la barra muestra "GPU: sin worker activo" cuando ningún worker ha mandado latido reciente.
- Ajustes nuevos: `adaceen.triggers.blockingSeconds`, `adaceen.triggers.suggestOnBlocking`, `adaceen.codeApplication.offlineMaxLines`.
- Pruebas unitarias sin descargar VS Code: `npm run test:unit` (`node:test`).

### Cambiado

- Los botones Insertar / Modificar / Eliminar de la ventana flotante solo aparecen cuando se puede aplicar código.
- El paquete ya no incluye `.devcontainer/`.

## [0.0.27] - 2026-09-24

### Corregido

- "Insertar debajo" sustituía el código en vez de agregarlo: las acciones que llegan por la cola (`insert_after_line`, `delete_selection`) no se reconocían porque el guion bajo impedía separar la palabra. Insertar desde la cola va debajo de la última línea seleccionada y cada aplicación deja una línea `[Apply]` en el canal ADACEEN.

## [Unreleased]

- Initial release
