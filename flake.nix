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
        pkgs.buildNpmPackage {
          pname = "vscode-extension-${manifest.name}";
          inherit (manifest) version;

          src = pkgs.lib.cleanSource ./.;

          nodejs = pkgs.nodejs_22;
          npmDepsHash = "sha256-GMxOJ7JROKvHAfFLsbcF2/OayKqkO6NfLyL8oA+e/UM=";
          npmBuildScript = "compile";

          dontConfigure = true;

          doCheck = true;
          checkPhase = ''
            runHook preCheck
            npm run check
            runHook postCheck
          '';

          installPhase = ''
            runHook preInstall

            extension_dir="$out/share/vscode/extensions/${uniqueId}"
            mkdir -p "$extension_dir"
            cp package.json README.md LICENSE "$extension_dir/"
            cp -R out "$extension_dir/out"

            runHook postInstall
          '';

          meta = {
            description = manifest.description;
            homepage = "https://github.com/kteal/margin";
            license = pkgs.lib.licenses.mit;
          };
        };

      vsixFor =
        pkgs:
        let
          manifest = builtins.fromJSON (builtins.readFile ./package.json);
        in
        pkgs.buildNpmPackage {
          pname = "${manifest.name}-vsix";
          inherit (manifest) version;

          src = pkgs.lib.cleanSource ./.;
          nodejs = pkgs.nodejs_22;
          npmDepsHash = "sha256-GMxOJ7JROKvHAfFLsbcF2/OayKqkO6NfLyL8oA+e/UM=";
          npmBuildScript = "compile";

          nativeBuildInputs = [ pkgs.vsce ];

          dontConfigure = true;

          installPhase = ''
            runHook preInstall
            vsce package --no-dependencies --out ${manifest.name}-${manifest.version}.vsix
            mkdir -p "$out"
            cp ${manifest.name}-${manifest.version}.vsix "$out/"
            runHook postInstall
          '';

          meta = {
            description = "VSIX package for the Margin VS Code extension";
            homepage = "https://github.com/kteal/margin";
            license = pkgs.lib.licenses.mit;
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
        pkgs.nixfmt
      );
    };
}
