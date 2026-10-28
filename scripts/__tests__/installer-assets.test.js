import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// O instalador do Windows (GOALS 22) não tem teste que o rode: estes testes seguram o que dá para
// conferir sem instalar nada — as imagens, a licença, a configuração e o texto do script NSIS.
const ROOT = path.resolve(__dirname, '../..');
const read = (file) => fs.readFileSync(path.join(ROOT, file));
const pkg = JSON.parse(read('package.json').toString('utf8'));
const nsis = pkg.build.nsis;

// BMP: "BM", largura em 18, altura em 22 (positiva = de baixo para cima), bits por pixel em 28 e
// compressão em 30. O NSIS só aceita 24 bits sem compressão.
function bmpInfo(file) {
  const bytes = read(file);
  return {
    signature: bytes.subarray(0, 2).toString('latin1'),
    width: bytes.readInt32LE(18),
    height: Math.abs(bytes.readInt32LE(22)),
    bits: bytes.readUInt16LE(28),
    compression: bytes.readUInt32LE(30),
  };
}

describe('imagens do instalador', () => {
  it('a barra lateral tem 164 x 314, 24 bits, sem compressão', () => {
    expect(bmpInfo(nsis.installerSidebar)).toEqual({
      signature: 'BM',
      width: 164,
      height: 314,
      bits: 24,
      compression: 0,
    });
  });

  it('o topo tem 150 x 57, 24 bits, sem compressão', () => {
    expect(bmpInfo(nsis.installerHeader)).toEqual({
      signature: 'BM',
      width: 150,
      height: 57,
      bits: 24,
      compression: 0,
    });
  });

  it('o desinstalador usa a mesma barra lateral', () => {
    expect(nsis.uninstallerSidebar).toBe(nsis.installerSidebar);
  });
});

describe('licença do instalador', () => {
  it('termina com o texto original e intacto de docs/LICENSE.txt', () => {
    const normalize = (buffer) =>
      buffer.toString('utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').trimEnd();
    const license = normalize(read('docs/LICENSE.txt'));
    const shown = normalize(read(nsis.license));
    expect(shown.endsWith(license)).toBe(true);
    expect(shown.length).toBeGreaterThan(license.length);
  });

  it('é UTF-8 com BOM, para o NSIS Unicode ler os acentos do resumo', () => {
    expect([...read(nsis.license).subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  });
});

describe('configuração do NSIS e do pacote', () => {
  it('o assistente é em português do Brasil, com inglês de reserva', () => {
    expect(nsis.installerLanguages).toEqual(['pt_BR', 'en_US']);
    expect(nsis.language).toBe('1046');
  });

  it('todos os arquivos apontados existem', () => {
    for (const key of [
      'license',
      'installerSidebar',
      'uninstallerSidebar',
      'installerHeader',
      'include',
    ]) {
      expect(fs.existsSync(path.join(ROOT, nsis[key])), key).toBe(true);
    }
  });

  it('o script de instalação dos programas vai dentro do pacote', () => {
    const entry = pkg.build.extraResources.find((item) => item.from === 'resources/prereqs');
    expect(entry).toMatchObject({ to: 'prereqs', filter: ['install-prereq.ps1'] });
    expect(fs.existsSync(path.join(ROOT, 'resources/prereqs/install-prereq.ps1'))).toBe(true);
  });
});

describe('scripts/installer.nsh (página "Programas necessários")', () => {
  const text = read(nsis.include).toString('utf8').replace(/^\uFEFF/, '');

  it('é UTF-8 com BOM', () => {
    expect([...read(nsis.include).subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  });

  it('põe a página depois da pasta, pelo gancho do electron-builder', () => {
    expect(text).toMatch(
      /!macro customPageAfterChangeDir\s+Page custom PrereqPageCreate PrereqPageLeave/,
    );
  });

  it('só define funções e textos fora do desinstalador (o NSIS trata aviso como erro)', () => {
    const header = /!macro customHeader([\s\S]*?)!macroend/.exec(text)[1];
    expect(header.trimStart().startsWith('!ifndef BUILD_UNINSTALLER')).toBe(true);
    expect(header.trimEnd().endsWith('!endif')).toBe(true);
  });

  it('não aparece em atualização nem em instalação silenciosa', () => {
    const create = /Function PrereqPageCreate([\s\S]*?)FunctionEnd/.exec(text)[1];
    expect(create).toMatch(/\$\{If\} \$\{isUpdated\}\s+Abort/);
    expect(create).toMatch(/\$\{If\} \$\{Silent\}\s+Abort/);
  });

  it('o Tailscale vem marcado e o TightVNC desmarcado na primeira vez', () => {
    const create = /Function PrereqPageCreate([\s\S]*?)FunctionEnd/.exec(text)[1];
    expect(create).toMatch(/\$PrereqTsWant != "0"\s+\$\{NSD_Check\} \$PrereqTsBox/);
    expect(create).toMatch(/\$PrereqVncWant == "1"\s+\$\{NSD_Check\} \$PrereqVncBox/);
  });

  it('todo texto usado tem versão em português e em inglês', () => {
    const defined = (language) =>
      new Set(
        [...text.matchAll(new RegExp(`LangString (\\w+) \\$\\{LANG_${language}\\}`, 'g'))].map(
          (m) => m[1],
        ),
      );
    const portuguese = defined('PORTUGUESEBR');
    const english = defined('ENGLISH');
    expect([...portuguese].sort()).toEqual([...english].sort());
    const used = new Set([...text.matchAll(/\$\((S_\w+)\)/g)].map((m) => m[1]));
    for (const name of used) expect(portuguese.has(name), name).toBe(true);
  });

  it('roda o script do pacote só com um nome fixo, sem shell e sem senha', () => {
    const call = /nsExec::Exec '([^']+)'/.exec(text)[1];
    expect(call).toContain(
      '-ExecutionPolicy Bypass -File "$INSTDIR\\resources\\prereqs\\install-prereq.ps1" -Name $0',
    );
    expect(call).not.toMatch(/cmd(\.exe)? \/c/i);
    expect(text).toMatch(/StrCpy \$0 "tailscale"/);
    expect(text).toMatch(/StrCpy \$0 "tightvnc"/);
  });

  it('a instalação dos programas só roda para o que foi marcado', () => {
    expect(text).toMatch(/\$\{If\} \$PrereqTsWant == "1"[\s\S]*?"tailscale"/);
    expect(text).toMatch(/\$\{If\} \$PrereqVncWant == "1"[\s\S]*?"tightvnc"/);
    expect(text).toMatch(/!macro customInstall\s+Call PrereqInstallChosen/);
  });
});
