{
  description = "Papercuts";

  # nixos-26.05: the stable branch gets security fixes without large version jumps.
  # `app-update` (dev VM) moves the pins: security fixes at once, everything else after
  # five days (docs: https://github.com/Tim-Conrad/app-template/blob/main/docs/updates.md).
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";
  };

  # Everything lives in nix/ (owned by the template, updated with `app-sync`).
  # Changes for this app only go into nix/local.nix.
  outputs =
    inputs:
    import ./nix {
      inherit inputs;
      name = "papercuts";
      profile = "custom";
    };
}
