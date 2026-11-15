# Changes for this app only. The rest of nix/ belongs to the app template and is
# overwritten by `app-sync`; this file is never overwritten.
#
# custom profile, a service: the papercuts relay (`papercuts serve`, Node without npm
# dependencies) on port 8000, with gh for the GitHub login of the host (mounted at /gh).
{ pkgs, lib, inputs, tpl }:
let
  # The files the relay and the CLI need, in one folder (the code finds widget/, icon.svg and
  # package.json relative to itself).
  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../bin
      ../src
      ../widget
      ../replay
      ../schema
      ../skills
      ../package.json
      ../LICENSE
      ../icon.svg
    ];
  };
  app = pkgs.runCommand "papercuts-app" { } ''
    mkdir -p $out/app
    cp -r ${src}/. $out/app/
  '';
  # `docker exec <relay> papercuts ...` runs the CLI of this build.
  cli = pkgs.writeShellScriptBin "papercuts" ''
    exec ${lib.getExe tpl.nodejs} /app/bin/papercuts.js "$@"
  '';
  node = lib.getExe tpl.nodejs;
  # Lint (biome.json) and tests in a copy of the repo, without network. The tests start local
  # servers (a fake GitHub on 127.0.0.1) and call git for the local store.
  checkSrc = tpl.cleanSrc ../.;
in
{
  service = {
    cmd = [ node "/app/bin/papercuts.js" "serve" ];
    health = [
      "CMD"
      node
      "-e"
      "fetch('http://127.0.0.1:8000/healthz').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
    ];
  };
  workingDir = "/app";
  runtimePackages = [ app tpl.nodejs pkgs.gh cli ];
  env = {
    PORT = "8000";
    # gh and the CLI write their config below HOME; the root file system is read-only.
    HOME = "/tmp";
    PAPERCUTS_SHOTS_DIR = "/data/shots";
  };
  checks = {
    unit = tpl.runCheck "unit" checkSrc [ tpl.nodejs pkgs.git ] ''
      git config --global user.email check@example.com
      git config --global user.name check
      node --test test/*.test.js
    '';
    skill = tpl.runCheck "skill" checkSrc [ tpl.nodejs ] "node bin/papercuts.js skill --check";
    lint = tpl.runCheck "lint" checkSrc [ tpl.biome ] "biome ci --no-errors-on-unmatched .";
  };
  iconDir = ".";
  # A new shots volume takes the owner of this folder, so uid 1000 can write pictures.
  dataDirs = [ "data/shots" ];
}
