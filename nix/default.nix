# Owned by the app template (https://github.com/Tim-Conrad/app-template). Do not edit in an
# app: `app-sync` overwrites it. Changes for one app go into ./local.nix.
#
# Outputs:
#   packages.image      the Docker image, built by Nix (streamLayeredImage, no Dockerfile)
#   packages.frontend   the built PWA (Vite); custom: the site from local.nix, if any
#   packages.venv       the Python environment from backend/uv.lock (uv2nix)      [fullstack]
#   checks.*            lint, types, tests, image build: `nix flake check`
#   apps.load           build the image and `docker load` it; prints the image reference
#   apps.gen-api        regenerate frontend/src/api/{openapi.json,schema.d.ts}  [fullstack]
#   apps.icons          PNG icons from frontend/public/icon.svg (custom: local.iconDir)
#   apps.dep-guard      lock files: no new vulnerability, foreign source or fresh flake pin
#   apps.biome/ruff     the pinned linters (git hooks in .githooks use them)
#   devShells.default   `direnv allow` / `nix develop`
{
  inputs,
  name,
  profile,
}:
let
  system = "x86_64-linux";
  pkgs = inputs.nixpkgs.legacyPackages.${system};
  inherit (pkgs) lib;
  fs = lib.fileset;
  fullstack = profile == "fullstack";
  # custom: the app keeps its own runtime (a game without React, a Node service, a page built by
  # a script). local.nix says what goes into the image (`site` or `service`); the template still
  # gives it the image, the version, papercuts, the device viewer, the gates and the updates.
  custom = profile == "custom";

  # local.nix may ask for `tpl` (helpers below) besides pkgs, lib and inputs.
  localFn = import ./local.nix;
  local = {
    runtimePackages = [ ];
    env = { };
    checks = { };
    pythonOverlay = _final: _prev: { };
    workingDir = "/data";
    # custom: static files to serve (a derivation or a path), or a service:
    #   { cmd = [ ... ]; health = [ "CMD" ... ]; } (health: a Docker healthcheck test).
    site = null;
    service = null;
    # HTML pages (relative to the site) that get the papercuts tag when PAPERCUTS_URL is set.
    papercutsPages = [ "index.html" ];
    # Where icon.svg lives and the PNG icons go (`nix run .#icons`).
    iconDir = if custom then "." else "frontend/public";
    # Extra tools, environment variables and shell code for the dev shell.
    devPackages = [ ];
    devEnv = { };
    devShellHook = "";
    # Folders in the image owned by uid 1000, e.g. [ "data/shots" ] for a named volume mounted
    # there (Docker copies the owner into a new volume).
    dataDirs = [ ];
  }
  // localFn (builtins.intersectAttrs (builtins.functionArgs localFn) {
    inherit pkgs lib inputs tpl;
  });

  # The version every app shows: the date of the commit and its short hash, e.g.
  # 2026.11.15+8682f7b. Nothing to bump by hand; a dirty tree ends in "-dirty".
  self = inputs.self;
  d = self.lastModifiedDate or "19700101000000";
  rev = self.shortRev or (self.dirtyShortRev or "unknown");
  version = "${builtins.substring 0 4 d}.${builtins.substring 4 2 d}.${builtins.substring 6 2 d}+${rev}";

  nodejs = pkgs.nodejs_24;
  python = pkgs.python314;
  biome = pkgs.biome;
  ruff = pkgs.ruff;

  # ---------- frontend ----------
  junk = dir: [
    (fs.maybeMissing (dir + "/node_modules"))
    (fs.maybeMissing (dir + "/dist"))
    (fs.maybeMissing (dir + "/.venv"))
    (fs.maybeMissing (dir + "/.pytest_cache"))
    (fs.maybeMissing (dir + "/.ruff_cache"))
  ];
  # A folder of the repo without build output and caches.
  cleanSrc =
    dir:
    fs.toSource {
      root = dir;
      fileset = fs.difference dir (fs.unions (junk dir));
    };
  mkFrontend =
    {
      pname,
      script,
      install,
      env ? { },
      src ? cleanSrc ../frontend,
      nativeBuildInputs ? [ ],
    }:
    pkgs.buildNpmPackage {
      inherit pname nodejs src;
      npmDeps = pkgs.importNpmLock { npmRoot = src; };
      version = "0";
      npmConfigHook = pkgs.importNpmLock.npmConfigHook;
      nativeBuildInputs = [ biome ] ++ nativeBuildInputs;
      npmBuildScript = script;
      env = {
        CI = "1";
      }
      // env;
      installPhase = ''
        runHook preInstall
        ${install}
        runHook postInstall
      '';
    };
  frontend =
    if custom then
      (
        if local.site == null || lib.isDerivation local.site then
          local.site
        else
          pkgs.runCommand "${name}-site" { } "cp -r ${local.site} $out"
      )
    else
      mkFrontend {
        pname = "${name}-frontend";
        script = "build";
        install = "cp -r dist $out";
        env.VITE_APP_VERSION = version;
      };
  frontendCheck = mkFrontend {
    pname = "${name}-frontend-check";
    script = "check";
    install = "touch $out";
  };

  # Helpers for nix/local.nix (ask for them with `{ pkgs, lib, inputs, tpl }:`).
  tpl = {
    inherit
      version
      nodejs
      python
      biome
      ruff
      cleanSrc
      ;
    # An npm project of the repo (needs its package-lock.json), e.g. a Vite build:
    #   tpl.npmBuild { src = tpl.cleanSrc ../.; }        -> dist/ as the site
    #   tpl.npmBuild { src = ...; script = "test"; install = "touch $out"; }   -> a check
    # VITE_APP_VERSION and APP_VERSION are set to the version.
    npmBuild =
      {
        src,
        script ? "build",
        install ? "cp -r dist $out",
        env ? { },
        pname ? "${name}-${script}",
        nativeBuildInputs ? [ ],
      }:
      mkFrontend {
        inherit
          src
          script
          install
          pname
          nativeBuildInputs
          ;
        env = {
          VITE_APP_VERSION = version;
          APP_VERSION = version;
        }
        // env;
      };
    # A check that runs a command in a copy of `src` (no network), e.g.
    #   tpl.runCheck "unit" (tpl.cleanSrc ../.) [ pkgs.nodejs ] "node --test test/"
    runCheck =
      checkName: src: inputs: cmd:
      pkgs.runCommand "${name}-${checkName}" { nativeBuildInputs = inputs; } ''
        cp -r ${src} src
        chmod -R u+w src
        cd src
        export HOME=$TMPDIR
        ${cmd}
        touch $out
      '';
  };

  # ---------- backend (fullstack) ----------
  backend = lib.optionalAttrs fullstack (
    let
      workspace = inputs.uv2nix.lib.workspace.loadWorkspace { workspaceRoot = ../backend; };
      overlay = workspace.mkPyprojectOverlay { sourcePreference = "wheel"; };
      pythonSet =
        (pkgs.callPackage inputs.pyproject-nix.build.packages { inherit python; }).overrideScope
          (
            lib.composeManyExtensions [
              inputs.pyproject-build-systems.overlays.wheel
              overlay
              local.pythonOverlay
            ]
          );
    in
    {
      venv = pythonSet.mkVirtualEnv "${name}-env" workspace.deps.default;
      devVenv = pythonSet.mkVirtualEnv "${name}-dev-env" workspace.deps.all;
      checkSrc = fs.toSource {
        root = ../.;
        fileset = fs.unions [
          (fs.difference ../backend (fs.unions (junk ../backend)))
          ../frontend/src/api/openapi.json
        ];
      };
    }
  );

  # ---------- image ----------
  envList = lib.mapAttrsToList (k: v: "${k}=${toString v}") local.env;
  baseEnv = [
    "APP_VERSION=${version}"
    "TZ=Europe/Berlin"
    "TZDIR=${pkgs.tzdata}/share/zoneinfo"
    "SSL_CERT_FILE=${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt"
  ];
  labels = {
    "org.opencontainers.image.title" = name;
    "org.opencontainers.image.version" = version;
    "org.opencontainers.image.revision" = self.rev or (self.dirtyRev or "unknown");
    "t7d.app-template.profile" = profile;
  };

  # The device viewer for sites that are not built from the template's frontend (custom).
  devViewer = pkgs.runCommand "${name}-dev-viewer" { nativeBuildInputs = [ pkgs.esbuild ]; } ''
    mkdir -p src/dev $out
    cp ${./dev-viewer.ts} src/dev/viewer.ts
    echo 'export const APP_VERSION = "${version}";' > src/version.ts
    esbuild src/dev/viewer.ts --bundle --format=esm --minify --outfile=$out/dev-viewer.js
    cat > $out/dev.html <<'HTML'
    <!doctype html>
    <html lang="en"><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex" /><title>${name} · devices</title></head>
    <body><div id="viewer"></div><script type="module" src="/dev-viewer.js"></script></body></html>
    HTML
  '';
  # Static sites (static and custom profiles) are served by nginx straight from the Nix store.
  # At start, serve-static writes the few files that depend on the container's environment into
  # /tmp/pages, which nginx looks at first: the pages of local.papercutsPages with the papercuts
  # tag (only when PAPERCUTS_URL is set), /version.json, and the device viewer /dev.html (only
  # with DEV_TOOLS=1). Hashed files under /assets are cached for a year, everything else is
  # revalidated (index.html, sw.js, the manifest, icons), so a deploy reaches every phone.
  # (static-web-server refuses symlinks out of its root, so it cannot serve an overlay.)
  siteRoot =
    if frontend == null then
      throw "nix/local.nix of a custom app sets `site` (static files) or `service`"
    else
      frontend;
  serveStatic = pkgs.writeShellApplication {
    name = "serve-static";
    runtimeInputs = [
      pkgs.coreutils
      pkgs.gnused
    ];
    text = ''
      site=${siteRoot}
      pages=/tmp/pages
      rm -rf "$pages" /tmp/nginx
      mkdir -p "$pages" /tmp/nginx
      url=''${PAPERCUTS_URL:-}
      url=''${url%/}
      repo=''${PAPERCUTS_REPO:-${name}}
      inject=0
      case "$url" in
        "") ;;
        http://* | https://*)
          if [[ $url =~ ^https?://[A-Za-z0-9._:-]+$ && $repo =~ ^[A-Za-z0-9._/-]+$ ]]; then
            inject=1
            echo "serve-static: papercuts widget from $url"
          else
            echo "serve-static: PAPERCUTS_URL or PAPERCUTS_REPO is not plain; no papercuts widget" >&2
          fi
          ;;
        *) echo "serve-static: PAPERCUTS_URL must start with http:// or https://; no papercuts widget" >&2 ;;
      esac
      if [ "$inject" = 1 ]; then
        list=(${lib.escapeShellArgs local.papercutsPages})
        for page in "''${list[@]}"; do
          [ -f "$site/$page" ] || continue
          mkdir -p "$(dirname "$pages/$page")"
          sed "0,/<\/head>/s||<script src=\"$url/papercuts.js\" data-repo=\"$repo\"></script></head>|" "$site/$page" > "$pages/$page"
        done
      fi
      # The version of this build for pages without a build step: GET /version.json.
      [ -e "$site/version.json" ] || printf '{"version":"%s"}\n' "${version}" > "$pages/version.json"
      devloc="location = /dev.html { return 404; }"
      if [ "''${DEV_TOOLS:-}" = 1 ]; then
        devloc=""
        ${lib.optionalString custom ''cp ${devViewer}/dev.html ${devViewer}/dev-viewer.js "$pages/"''}
      fi
      fallback=$site/index.html
      [ -f "$pages/index.html" ] && fallback=$pages/index.html
      cat > /tmp/nginx/nginx.conf <<NGINX
      daemon off;
      worker_processes 1;
      pid /tmp/nginx/nginx.pid;
      error_log stderr warn;
      events { worker_connections 256; }
      http {
        include ${pkgs.nginx}/conf/mime.types;
        types { application/manifest+json webmanifest; text/javascript mjs; }
        default_type application/octet-stream;
        access_log off;
        server_tokens off;
        sendfile on;
        gzip on;
        gzip_types text/css text/javascript application/javascript application/json image/svg+xml application/manifest+json;
        client_body_temp_path /tmp/nginx/body;
        proxy_temp_path /tmp/nginx/proxy;
        fastcgi_temp_path /tmp/nginx/fastcgi;
        uwsgi_temp_path /tmp/nginx/uwsgi;
        scgi_temp_path /tmp/nginx/scgi;
        server {
          listen 8000;
          root /;
          disable_symlinks off;
          autoindex off;
          location = /health { access_log off; default_type text/plain; return 200 "ok\n"; }
          $devloc
          location ^~ /assets/ {
            add_header Cache-Control "public, max-age=31536000, immutable" always;
            try_files $site\$uri =404;
          }
          location / {
            add_header Cache-Control "no-cache" always;
            try_files $pages\$uri $pages\''${uri}index.html $site\$uri $site\''${uri}index.html $fallback =404;
          }
        }
      }
      NGINX
      exec ${pkgs.nginx}/bin/nginx -e stderr -c /tmp/nginx/nginx.conf
    '';
  };
  staticConfig = {
    User = "1000:1000";
    Cmd = [ (lib.getExe serveStatic) ];
    Env = baseEnv ++ envList;
    ExposedPorts."8000/tcp" = { };
    Healthcheck = {
      Test = [
        "CMD"
        "${pkgs.curlMinimal}/bin/curl"
        "-fsS"
        "-o"
        "/dev/null"
        "http://127.0.0.1:8000/health"
      ];
      Interval = 30000000000;
      Timeout = 5000000000;
      Retries = 3;
    };
    Labels = labels;
  };
  serviceConfig = lib.optionalAttrs (local.service != null) {
    User = "1000:1000";
    WorkingDir = local.workingDir;
    Cmd = local.service.cmd;
    Env = baseEnv ++ envList;
    ExposedPorts."8000/tcp" = { };
    Healthcheck = {
      Test = local.service.health;
      Interval = 30000000000;
      Timeout = 5000000000;
      StartPeriod = 20000000000;
      Retries = 3;
    };
    Labels = labels;
  };

  image = pkgs.dockerTools.streamLayeredImage {
    inherit name;
    # tag = null: the tag is the hash of the image, so two worktrees never share a tag.
    # The lab retags the loaded image as <name>:latest (lab-ctl).
    tag = null;
    contents = [
      pkgs.cacert
      pkgs.tzdata
    ]
    ++ local.runtimePackages;
    fakeRootCommands = ''
      mkdir -p data tmp
      chown 1000:1000 data
      chmod 1777 tmp
      ${lib.concatMapStrings (d: ''
        mkdir -p ${lib.escapeShellArg d}
        chown 1000:1000 ${lib.escapeShellArg d}
      '') local.dataDirs}
    '';
    config =
      if fullstack then
        {
          User = "1000:1000";
          WorkingDir = local.workingDir;
          Cmd = [
            "${backend.venv}/bin/uvicorn"
            "app.main:create_app"
            "--factory"
            "--host"
            "0.0.0.0"
            "--port"
            "8000"
            "--proxy-headers"
            "--no-server-header"
          ];
          Env =
            baseEnv
            ++ [
              # `docker exec <app> python ...` finds the app's environment.
              "PATH=${backend.venv}/bin"
              "STATIC_DIR=${frontend}"
              "DATA_DIR=/data"
              # X-Forwarded-* only from Traefik's network on the lab (lab-ctl creates `proxy` as
              # 172.30.0.0/24); any other container could otherwise fake its client address.
              "FORWARDED_ALLOW_IPS=172.30.0.0/24"
              "PYTHONUNBUFFERED=1"
              "PYTHONDONTWRITEBYTECODE=1"
            ]
            ++ envList;
          ExposedPorts."8000/tcp" = { };
          Healthcheck = {
            Test = [
              "CMD"
              "${backend.venv}/bin/python"
              "-c"
              "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/health', timeout=3)"
            ];
            Interval = 30000000000;
            Timeout = 5000000000;
            StartPeriod = 20000000000;
            Retries = 3;
          };
          Labels = labels;
        }
      else if local.service != null then
        serviceConfig
      else
        staticConfig;
  };

  # ---------- apps ----------
  app = drv: {
    type = "app";
    program = lib.getExe drv;
  };
  load = pkgs.writeShellApplication {
    name = "load";
    runtimeInputs = [
      pkgs.docker-client
      pkgs.gnugrep
      pkgs.coreutils
    ];
    text = ''
      # Build the image, load it into Docker, print the reference (name:tag).
      ref=$(${image} | docker load | grep -oP '(?<=Loaded image: ).*' | tail -1)
      [ -n "$ref" ] || { echo "load: docker load printed no image" >&2; exit 1; }
      echo "$ref"
    '';
  };
  icons = pkgs.writeShellApplication {
    name = "icons";
    runtimeInputs = [ pkgs.librsvg ];
    text = ''
      # PNG icons for the PWA from ${local.iconDir}/icon.svg (run in the repo root).
      cd ${lib.escapeShellArg local.iconDir}
      mkdir -p icons
      rsvg-convert -w 192 -h 192 icon.svg -o icons/icon-192.png
      rsvg-convert -w 512 -h 512 icon.svg -o icons/icon-512.png
      rsvg-convert -w 180 -h 180 -b "$(grep -oP 'data-bg="\K[^"]+' icon.svg || echo '#ffffff')" icon.svg -o icons/apple-touch-icon.png
      # maskable: the icon at 80% on a full square, so Android can cut any shape out of it
      tmp=$(mktemp -d)
      rsvg-convert -w 410 -h 410 icon.svg -o "$tmp/inner.png"
      ${pkgs.imagemagick}/bin/magick -size 512x512 "xc:$(grep -oP 'data-bg="\K[^"]+' icon.svg || echo '#ffffff')" "$tmp/inner.png" -gravity center -composite icons/maskable-512.png
      rm -r "$tmp"
      echo "icons written to ${local.iconDir}/icons"
    '';
  };
  genApi = pkgs.writeShellApplication {
    name = "gen-api";
    runtimeInputs = [
      nodejs
      biome
    ]
    ++ lib.optional fullstack backend.devVenv;
    text = ''
      # frontend/src/api/openapi.json from the FastAPI app, then schema.d.ts from it.
      [ -d backend ] && [ -d frontend ] || { echo "gen-api: run in the repo root" >&2; exit 1; }
      [ -d frontend/node_modules ] || (cd frontend && npm ci --no-audit --no-fund --loglevel=error)
      (cd backend && DATA_DIR="$(mktemp -d)" python -m app.openapi) > frontend/src/api/openapi.json
      (cd frontend && npm run --silent gen:api)
      echo "frontend/src/api/openapi.json and schema.d.ts are up to date"
    '';
  };
  freezePins = pkgs.writeShellApplication {
    name = "freeze-pins";
    runtimeInputs = [ pkgs.git ];
    text = "exec ${python}/bin/python3 ${./freeze-pins.py} \"$@\"";
  };
  depGuard = pkgs.writeShellApplication {
    name = "dep-guard";
    runtimeInputs = [
      pkgs.osv-scanner
      pkgs.git
    ];
    text = "exec ${python}/bin/python3 ${./dep-guard.py} \"$@\"";
  };
in
{
  packages.${system} = {
    inherit image;
    version = pkgs.writeText "${name}-version" version;
    default = image;
  }
  // lib.optionalAttrs (frontend != null) { inherit frontend; }
  // lib.optionalAttrs fullstack { inherit (backend) venv; };

  checks.${system} = {
    image = image;
  }
  // lib.optionalAttrs (!custom) { frontend = frontendCheck; }
  // lib.optionalAttrs fullstack {
    backend =
      pkgs.runCommand "${name}-backend-check"
        {
          nativeBuildInputs = [
            backend.devVenv
            ruff
          ];
        }
        ''
          cp -r ${backend.checkSrc} src
          chmod -R u+w src
          cd src/backend
          export HOME=$TMPDIR DATA_DIR=$TMPDIR/data
          # The sandbox has no network, but code that builds HTTP clients at startup needs a CA file.
          export SSL_CERT_FILE=${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt
          ruff check --no-cache .
          ruff format --no-cache --check .
          python -m pytest -q -p no:cacheprovider
          touch $out
        '';
  }
  // local.checks;

  apps.${system} = {
    load = app load;
    icons = app icons;
    dep-guard = app depGuard;
    freeze-pins = app freezePins;
    biome = app biome;
    ruff = app ruff;
  }
  // lib.optionalAttrs fullstack { gen-api = app genApi; };

  devShells.${system}.default = pkgs.mkShell {
    packages = [
      nodejs
      biome
      ruff
      pkgs.git
      pkgs.osv-scanner
    ]
    ++ lib.optionals fullstack [
      python
      pkgs.uv
    ]
    ++ local.devPackages;
    env =
      lib.optionalAttrs fullstack {
        UV_PYTHON = python.interpreter;
        UV_PYTHON_DOWNLOADS = "never";
        UV_NO_MANAGED_PYTHON = "1";
      }
      // local.devEnv;
    shellHook = ''
      # Local gates before anything reaches GitHub (.githooks: dep-guard and lint on commit,
      # nix flake check on push).
      if [ -d .githooks ] && [ "$(git config --get core.hooksPath)" != .githooks ]; then
        git config core.hooksPath .githooks
      fi
      # The five-day freeze for every npm command in this shell (security fixes: app-update,
      # or `npm_config_before= npm audit fix`). uv reads it from backend/pyproject.toml.
      export npm_config_before="$(date -u -d '5 days ago' +%FT%TZ)"
      ${lib.optionalString fullstack ''
        if [ -f backend/uv.lock ]; then
          (cd backend && uv sync --frozen --quiet) && export PATH="$PWD/backend/.venv/bin:$PATH"
        fi
      ''}
      for d in frontend .; do
        if [ -f "$d/package-lock.json" ] && [ ! -d "$d/node_modules" ]; then
          (cd "$d" && npm ci --no-audit --no-fund --loglevel=error)
        fi
      done
      ${local.devShellHook}
    '';
  };

  formatter.${system} = pkgs.nixfmt;
}
