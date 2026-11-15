# Conector de Tranquiseo para webs Astro

Tranquiseo trabaja el SEO de tu web: revisa títulos y descripciones, mejora textos y publica
artículos. En una web WordPress eso lo hace un plugin; en una web hecha con **Astro** lo hace este
conector, que funciona como una **GitHub Action** dentro del repositorio de tu web.

Cada 30 minutos la Action pregunta a Tranquiseo si hay trabajo. Si lo hay, aplica los cambios a los
ficheros de contenido (`.md`), comprueba que la web sigue compilando, los sube a la rama principal y
devuelve el resultado. Lo hace en **tres trabajos separados** (ver «Seguridad de tu repositorio»): la
clave de tu web nunca está en la misma máquina en la que se instalan las dependencias y se compila. Tu plataforma de alojamiento (Netlify, Vercel, Cloudflare Pages o tu propio
workflow) publica la web como siempre que hay un cambio en esa rama.

## Qué necesitas

- La web en un repositorio de **GitHub**, y permiso de administración en él.
- **Node 22** o superior en tu ordenador.
- La CLI de GitHub, [`gh`](https://cli.github.com), con la sesión iniciada (`gh auth login`).
- El **código de alta** que aparece en tu panel de Tranquiseo (caduca a los 15 minutos).

## Instalación

### 1. El fichero de configuración

En la raíz del repo, `tranquiseo.config.json` dice al conector dónde está tu contenido y qué
campos tiene. Te lo preparamos nosotros a partir de tu `content.config.ts`; este es su esqueleto:

```json
{
  "version": 1,
  "home_url": "https://tuweb.com",
  "colecciones": {
    "post": { "nombre": "blog", "dir": "src/content/blog", "url": "/blog/{slug}/",
              "campos": { "titulo": "title", "seo_descripcion": "description", "fecha": "date" } }
  },
  "media": { "dir": "public/media", "url": "/media" },
  "rutas_permitidas": ["src/content/blog/", "public/media/"]
}
```

El conector **solo puede escribir dentro de `rutas_permitidas`** y en su carpeta `.tranquiseo/`.
Nunca toca el código de la web, `.github/`, `package.json`, `astro.config.*` ni este fichero.

### 2. El alta

Dentro de la carpeta del repo:

```bash
npx github:tranquiseo/conector-astro#49ba10e80b5665888566ddc421f264d7dd370b5c alta ABC123-DEF456-GHI789-JKL012
```

Esto:

1. Genera en tu ordenador una clave nueva para la web.
2. Guarda la parte privada como secreto del repo (`TRANQUISEO_CLAVE_SITIO`). **No se muestra en
   pantalla ni se guarda en ningún fichero**: solo GitHub la tiene, y nadie puede leerla desde fuera.
3. Envía a Tranquiseo la parte pública, firmada, junto con el código.
4. Escribe en `tranquiseo.config.json` el identificador de tu web y en `.tranquiseo/publicas.json`
   las claves con las que Tranquiseo firma su trabajo.
5. Si no lo tienes, añade el workflow en `.github/workflows/tranquiseo.yml`.

Si algo falla, no queda nada a medias: se borra el secreto y no se toca ningún fichero.

### 3. Subir el alta

```bash
git add tranquiseo.config.json .tranquiseo .github/workflows/tranquiseo.yml
git commit -m "Tranquiseo: alta"
git push
```

Desde ese momento la Action se ejecuta sola. Puedes lanzarla a mano en la pestaña **Actions →
Tranquiseo → Run workflow**.

## Lo que conviene saber

- **Coste de GitHub Actions.** GitHub cobra cada trabajo (job) redondeado al minuto. Una ejecución sin
  cambios, o que solo consulta datos, es un trabajo: 1 minuto. Una con cambios que compilar son tres:
  unos 3-6 minutos según lo que tarde en compilar tu web y en publicarse. Cada 30 minutos sin cambios
  son unos 1.440 minutos al mes, dentro de los 2.000 que trae gratis un repo privado; cada lote de
  cambios suma unos 2-3 minutos más que con un solo trabajo. Si lo bajas a cada
  10 minutos (unos 4.300 al mes) necesitarás un plan de pago de GitHub. Si cambias el intervalo en el
  workflow, pon el mismo valor, en segundos, en `intervalo` de `tranquiseo.config.json`.
- **Repo público.** Lo que el conector guarda en `.tranquiseo/` y los registros de Actions serían
  públicos (nunca llevan contenido ni secretos). Además, GitHub desactiva los workflows programados de
  un repo público tras 60 días sin actividad.
- **Rama protegida.** Si la rama principal exige revisión por pull request, el conector no puede
  publicar. Tranquiseo lo verá y te avisará.
- **Cada cambio es un commit** de `tranquiseo[bot]`. Para deshacer uno: `git revert <commit>`.
- **Nada se publica sin compilar.** Si la web no compila con un cambio, no se sube nada y se reintenta.
- **Entrega controlada.** Con `"escrituras": false` en `tranquiseo.config.json` el conector solo lee:
  Tranquiseo analiza tu web y te propone cambios en el panel, pero no escribe nada en el repositorio.
  Cuando quieras que los cambios se apliquen, quita esa línea.

## Seguridad de tu repositorio

El conector puede escribir en la rama principal de tu web, así que quien controle tu repositorio en GitHub controla
también lo que el conector publica. Te recomendamos:

- **Verificación en dos pasos** en todas las cuentas de GitHub con permiso de escritura en el repositorio.
- **El secreto `TRANQUISEO_CLAVE_SITIO` como secreto del repositorio** (Settings > Secrets and variables > Actions),
  y el workflow tal cual: pasa solo ese secreto, por su nombre (nunca `secrets: inherit`).
- **Runners de GitHub** (`ubuntu-latest`, que es lo que usa el conector). Con runners propios compartidos entre
  trabajos, la separación de abajo no protege nada.
- **Nadie de fuera con permiso de escritura**: colaboradores externos, como mucho, con permiso de lectura.
- **Dependabot** para las Actions: copia `ejemplos/dependabot.yml` a `.github/dependabot.yml`.
- Si tu despliegue no va por un workflow propio, deja `actions: write` comentado en el workflow (viene así).

**Por qué tres trabajos.** Compilar tu web ejecuta el código de sus dependencias npm. Si una de ellas estuviera
comprometida, no debe poder leer la clave de tu web ni el permiso de escritura. Por eso el conector trabaja así:

1. **Aplicar** (con la clave, sin instalar ni ejecutar nada de tu web): pregunta a Tranquiseo, comprueba la firma y
   prepara los cambios.
2. **Compilar** (sin la clave y con permiso solo de lectura): aplica esos cambios en una máquina nueva, instala las
   dependencias y compila. Si falla, no se publica nada.
3. **Publicar** (con la clave, sin instalar ni ejecutar nada de tu web): en otra máquina nueva, comprueba que los
   cambios son exactamente los que preparó el paso 1 (por su huella), los sube a la rama principal y responde a
   Tranquiseo.

## Darse de baja

```bash
npx github:tranquiseo/conector-astro#49ba10e80b5665888566ddc421f264d7dd370b5c baja
```

Lanza la Action una última vez para avisar a Tranquiseo (firmado con la clave de la web), espera a
que termine, y después borra el secreto y desactiva el workflow. Haz `git pull` para traerte el
commit de la baja.

Si el workflow no funciona y quieres cortar igualmente: `npx github:tranquiseo/conector-astro baja --forzar`
(no avisa a Tranquiseo: desconecta también la web desde tu panel).

Para volver a conectar hace falta un código nuevo y repetir el alta.

---

## Para desarrollo

- `.github/workflows/conector.yml` es el workflow reutilizable (tres jobs: aplicar → compilar → publicar)
  que llama la web del cliente (`ejemplos/workflow.yml`).
- `action.yml` es una acción compuesta con una entrada `fase`: instala las dependencias del conector con el
  lockfile y sin scripts de instalación, y ejecuta `src/action.js`, que lee la clave y el token y los borra
  del entorno antes de hacer nada (y en la fase compilar se niega a arrancar si le llega alguno).
- Las tres llamadas internas a la acción (`tranquiseo/conector-astro@…`) van fijadas por el mismo SHA
  completo, igual que la línea `uses:` del ejemplo; las Actions de GitHub que usa, también.
- Las pruebas y la especificación viven en el repositorio de desarrollo de Tranquiseo, que no es público.
- Licencia: GPL-2.0 o posterior (la misma que el plugin de WordPress de Tranquiseo). Ver `LICENSE`.
