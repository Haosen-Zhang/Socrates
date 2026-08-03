# Third-party notices

## OpenCode design references

The resizable panel interaction and optional modern flat theme in Socrates were informed by patterns in
[anomalyco/opencode](https://github.com/anomalyco/opencode), licensed under the MIT License
(Copyright 2025 opencode). The Socrates implementation is an independent React adaptation;
OpenCode's SolidJS components and stylesheets are not bundled.

Socrates uses the following third-party packages for bounded document creation
and desktop interface icons. Packages are consumed as dependencies; no upstream
source is copied or modified in this repository.

| Package | Version | Purpose | License | Upstream |
| --- | --- | --- | --- | --- |
| `fflate` | 0.8.3 | ZIP creation | MIT | https://github.com/101arrowz/fflate |
| `docx` | 9.7.1 | DOCX creation | MIT | https://github.com/dolanmiu/docx |
| `exceljs` | 4.4.0 | XLSX creation | MIT | https://github.com/exceljs/exceljs |
| `lucide-react` | 1.28.0 | Default-theme interface icons | ISC (with MIT-licensed Feather-derived icons) | https://github.com/lucide-icons/lucide |

The packages' full license texts remain available in their distributed package
directories and upstream repositories.
