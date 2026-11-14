{
  description = "papercuts (relay, widget, CLI): dev shell";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { nixpkgs, ... }:
    let
      system = "x86_64-linux";
      pkgs = nixpkgs.legacyPackages.${system};
    in
    {
      # `direnv allow` (or `nix develop`). Preview: `wt up` (compose.preview.yml).
      # Tests: npm test
      devShells.${system}.default = pkgs.mkShell {
        packages = [
          pkgs.nodejs_22
          pkgs.git
        ];
      };
    };
}
