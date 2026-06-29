{
  description = "Margin VS Code extension";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs =
    { nixpkgs, ... }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];

      forAllSystems = nixpkgs.lib.genAttrs systems;

      packageFor =
        pkgs:
        let
          manifest = builtins.fromJSON (builtins.readFile ./package.json);
          uniqueId = "${manifest.publisher}.${manifest.name}";
        in
        pkgs.stdenvNoCC.mkDerivation {
          pname = "vscode-extension-${manifest.name}";
          inherit (manifest) version;

          src = pkgs.lib.cleanSource ./.;

          nativeBuildInputs = [ pkgs.nodejs_22 ];

          dontConfigure = true;
          dontBuild = true;

          doCheck = true;
          checkPhase = ''
            runHook preCheck
            node --check extension.js
            runHook postCheck
          '';

          installPhase = ''
            runHook preInstall

            extension_dir="$out/share/vscode/extensions/${uniqueId}"
            mkdir -p "$extension_dir"
            cp package.json extension.js README.md "$extension_dir/"

            runHook postInstall
          '';

          meta = {
            description = manifest.description;
            homepage = "https://github.com/kteal/margin";
            license = pkgs.lib.licenses.mit;
            platforms = pkgs.lib.platforms.all;
          };
        };

      vsixFor =
        pkgs:
        let
          manifest = builtins.fromJSON (builtins.readFile ./package.json);
        in
        pkgs.stdenvNoCC.mkDerivation {
          pname = "${manifest.name}-vsix";
          inherit (manifest) version;

          src = pkgs.lib.cleanSource ./.;

          nativeBuildInputs = [
            pkgs.nodejs_22
            pkgs.vsce
          ];

          dontConfigure = true;

          buildPhase = ''
            runHook preBuild
            vsce package --no-dependencies --out ${manifest.name}-${manifest.version}.vsix
            runHook postBuild
          '';

          installPhase = ''
            runHook preInstall
            mkdir -p "$out"
            cp ${manifest.name}-${manifest.version}.vsix "$out/"
            runHook postInstall
          '';

          meta = {
            description = "VSIX package for the Margin VS Code extension";
            homepage = "https://github.com/kteal/margin";
            license = pkgs.lib.licenses.mit;
            platforms = pkgs.lib.platforms.all;
          };
        };
    in
    {
      packages = forAllSystems (
        system:
        let
          pkgs = import nixpkgs { inherit system; };
          extension = packageFor pkgs;
        in
        {
          default = extension;
          margin = extension;
          vsix = vsixFor pkgs;
        }
      );

      devShells = forAllSystems (
        system:
        let
          pkgs = import nixpkgs { inherit system; };
        in
        {
          default = pkgs.mkShell {
            packages = [
              pkgs.nodejs_22
              pkgs.vsce
            ];
          };
        }
      );

      formatter = forAllSystems (
        system:
        let
          pkgs = import nixpkgs { inherit system; };
        in
        pkgs.nixfmt-rfc-style
      );
    };
}
