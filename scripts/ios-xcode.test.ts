import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { prepareXcodeProject } from './ios-xcode.ts';

const rust_command = 'pnpm tauri ios xcode-script --configuration "${CONFIGURATION:?}" ${ARCHS:?}\n';
const environment_line = '. "${PROJECT_DIR:?}/.tauri/xcode-env.sh"';
const archive_ref_id = 'E08F1517D6D7EB586B6CBFE7';
const project_fixture = [
  '// !$*UTF8*$!',
  '{',
  '  objects = {',
  `    ${archive_ref_id} /* libapp.a */ = {isa = PBXFileReference; lastKnownFileType = archive.ar; path = libapp.a; sourceTree = "<group>"; };`,
  `    C4C85734F471821D294412CA /* libapp.a in Frameworks */ = {isa = PBXBuildFile; fileRef = ${archive_ref_id} /* libapp.a */; };`,
  '    frameworks = {',
  '      isa = PBXFrameworksBuildPhase;',
  '      files = (',
  '        C4C85734F471821D294412CA /* libapp.a in Frameworks */,',
  '        UIKit,',
  '      );',
  '    };',
  '    5B8FA7922E3E25171556F5C1 /* Build Rust Code */ = {',
  '      isa = PBXShellScriptBuildPhase;',
  '      alwaysOutOfDate = 1;',
  '      outputPaths = (',
  '        "$(SRCROOT)/Externals/x86_64/${CONFIGURATION}/libapp.a",',
  '        "$(SRCROOT)/Externals/arm64/${CONFIGURATION}/libapp.a",',
  '      );',
  `      shellScript = ${JSON.stringify(rust_command)};`,
  '    };',
  '    debug = {',
  '      isa = XCBuildConfiguration;',
  '      buildSettings = {',
  '        DEVELOPMENT_TEAM = ORIGINAL_TEAM; CODE_SIGN_STYLE = Automatic;',
  '        "LIBRARY_SEARCH_PATHS[arch=arm64]" = "$(PROJECT_DIR)/Externals/arm64/$(CONFIGURATION)";',
  '      };',
  '    };',
  '    resources = { isa = PBXResourcesBuildPhase; files = (Assets); };',
  '  };',
  '}',
].join('\n');
const template_fixture = [
  'name: papertrail',
  'targets:',
  '  papertrail_iOS:',
  '    sources:',
  '      - path: Externals',
  '        excludes: ["**/*.a"]',
  '    settings:',
  '      base:',
  '        DEVELOPMENT_TEAM: ORIGINAL_TEAM',
  '        LIBRARY_SEARCH_PATHS[arch=arm64]: $(PROJECT_DIR)/Externals/arm64/$(CONFIGURATION)',
  '    dependencies:',
  '      - framework: libapp.a',
  '        embed: false',
  '      - sdk: UIKit.framework',
  '    preBuildScripts:',
  `      - script: ${rust_command.trimEnd()}`,
  '        name: Build Rust Code',
  '        basedOnDependencyAnalysis: false',
  '        outputFiles:',
  '          - $(SRCROOT)/Externals/x86_64/${CONFIGURATION}/libapp.a',
  '          - $(SRCROOT)/Externals/arm64/${CONFIGURATION}/libapp.a',
].join('\n');

const temporary_directories: string[] = [];

function createProject(project = project_fixture, template = template_fixture) {
  const apple_directory = mkdtempSync(join(tmpdir(), 'papertrail-xcode-test-'));
  temporary_directories.push(apple_directory);
  const project_directory = join(apple_directory, 'papertrail.xcodeproj');
  mkdirSync(project_directory);
  const project_file = join(project_directory, 'project.pbxproj');
  const template_file = join(apple_directory, 'project.yml');
  writeFileSync(project_file, project);
  writeFileSync(template_file, template);
  return { apple_directory, project_file, template_file };
}

afterEach(() => {
  for (const directory of temporary_directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('local Xcode preparation', () => {
  it.each([
    ['arm64', 'debug'], ['arm64', 'release'],
    ['x86_64', 'debug'], ['x86_64', 'release'],
  ])('connects the linked %s %s archive to the Rust build phase output', (arch, configuration) => {
    const files = createProject();
    prepareXcodeProject(files.apple_directory, ['/stable/node/bin', '/stable/rust/bin']);
    const project = readFileSync(files.project_file, 'utf8');
    const reference = project.match(/\/\* libapp\.a \*\/ = \{[^}]*\};/)?.[0];
    expect(reference).toContain('sourceTree = SOURCE_ROOT;');
    const archive_path = JSON.parse(reference!.match(/\bpath = ("[^"]+");/)![1]) as string;
    const flags = JSON.parse(project.match(/OTHER_LDFLAGS = ("(?:\\.|[^"\\])*");/)![1]) as string;
    const explicit_archive = flags.match(/"([^"]+\/libapp\.a)"/)![1];
    const linked_archive = explicit_archive.replaceAll('$(PROJECT_DIR)', files.apple_directory)
      .replaceAll('$(CURRENT_ARCH)', arch).replaceAll('$(CONFIGURATION)', configuration);
    const output_paths = [...project.matchAll(/"(\$\(SRCROOT\)\/Externals\/[^"\n]+\/libapp\.a)"/g)]
      .map((match) => match[1].replaceAll('$(SRCROOT)', files.apple_directory).replaceAll('${CONFIGURATION}', configuration));
    expect(output_paths).toContain(linked_archive);
    expect(project).not.toContain('libapp.a in Frameworks');
    expect(project).toContain('UIKit,');
    expect(project).toContain('resources = { isa = PBXResourcesBuildPhase; files = (Assets); };');
    const template = readFileSync(files.template_file, 'utf8');
    expect(JSON.parse(template.match(/- framework: ("[^"\n]+");?/)![1])).toBe(archive_path);
    expect(template).toContain('excludes: ["**/*.a"]');
    expect(template).toContain('embed: false');
    expect(template).toContain('link: false');
    const template_flags = JSON.parse(template.match(/OTHER_LDFLAGS: ("(?:\\.|[^"\\])*")/)![1]) as string;
    expect(template_flags).toBe(flags);
  });

  it.each(['string', 'list'])('preserves existing %s linker flags and inherits shared settings', (format) => {
    const original_flags = format === 'string' ? '"$(inherited) -ObjC -Wl,-no_warn_duplicate_libraries"'
      : '("$(inherited)", "-ObjC", "-Wl,-no_warn_duplicate_libraries",)';
    const template_flags = format === 'string' ? '"$(inherited) -ObjC -Wl,-no_warn_duplicate_libraries"'
      : '["$(inherited)", "-ObjC", "-Wl,-no_warn_duplicate_libraries"]';
    const project = project_fixture.replace('        DEVELOPMENT_TEAM', `        OTHER_LDFLAGS = ${original_flags};\n        DEVELOPMENT_TEAM`);
    const template = template_fixture.replace('        DEVELOPMENT_TEAM', `        OTHER_LDFLAGS: ${template_flags}\n        DEVELOPMENT_TEAM`);
    const files = createProject(project, template);
    prepareXcodeProject(files.apple_directory, ['/stable/node/bin']);
    for (const file of [files.project_file, files.template_file]) {
      const result = readFileSync(file, 'utf8');
      expect(result).toContain('$(inherited)');
      expect(result).toContain('-ObjC');
      expect(result).toContain('-Wl,-no_warn_duplicate_libraries');
      expect(result).toContain('$(PROJECT_DIR)/Externals/$(CURRENT_ARCH)/$(CONFIGURATION)/libapp.a');
      prepareXcodeProject(files.apple_directory, ['/stable/node/bin']);
      expect(readFileSync(file, 'utf8')).toBe(result);
    }
    if (format === 'list') {
      const project_flags = readFileSync(files.project_file, 'utf8').match(/OTHER_LDFLAGS = ([^\n]+);/)![1];
      const parsed_project_flags = JSON.parse(`[${project_flags.slice(1, -1)}]`) as string[];
      const parsed_template_flags = JSON.parse(readFileSync(files.template_file, 'utf8').match(/OTHER_LDFLAGS: (\[[^\n]+\])/)![1]) as string[];
      expect(parsed_project_flags).toEqual(parsed_template_flags);
      expect(parsed_project_flags).toEqual(['$(inherited)', '-ObjC', '-Wl,-no_warn_duplicate_libraries', '$(PROJECT_DIR)/Externals/$(CURRENT_ARCH)/$(CONFIGURATION)/libapp.a']);
    }
  });

  it('is idempotent and preserves signing, script arguments, and architecture-specific outputs', () => {
    const files = createProject();
    const tools = ['/stable/node/bin', '/stable/rust/bin'];
    prepareXcodeProject(files.apple_directory, tools);
    const project = readFileSync(files.project_file, 'utf8');
    const template = readFileSync(files.template_file, 'utf8');
    prepareXcodeProject(files.apple_directory, tools);
    expect(readFileSync(files.project_file, 'utf8')).toBe(project);
    expect(readFileSync(files.template_file, 'utf8')).toBe(template);
    const encoded_script = project.match(/shellScript = ("(?:\\.|[^"\\])*");/)![1];
    expect(JSON.parse(encoded_script)).toBe(`${environment_line}\n${rust_command}`);
    expect(project).toContain('DEVELOPMENT_TEAM = ORIGINAL_TEAM; CODE_SIGN_STYLE = Automatic;');
    expect(template).toContain('DEVELOPMENT_TEAM: ORIGINAL_TEAM');
    expect(template).toContain('basedOnDependencyAnalysis: false');
    expect(template).toContain('Externals/arm64/${CONFIGURATION}/libapp.a');
    expect(template).toContain('Externals/x86_64/${CONFIGURATION}/libapp.a');
    expect(template).not.toContain('Externals/$(CURRENT_ARCH)/${CONFIGURATION}/libapp.a');
    expect(template.split(environment_line)).toHaveLength(2);
  });

  it.each(['project reference', 'template dependency'])('leaves generated files intact when the %s is missing', (missing) => {
    const project = missing === 'project reference' ? project_fixture.replace('/* libapp.a */ = {isa = PBXFileReference;', '/* unexpected.a */ = {isa = PBXFileReference;') : project_fixture;
    const template = missing === 'template dependency' ? template_fixture.replace('- framework: libapp.a', '- framework: unexpected.a') : template_fixture;
    const files = createProject(project, template);
    expect(() => prepareXcodeProject(files.apple_directory, ['/stable/node/bin'])).toThrow(/archive/);
    expect(readFileSync(files.project_file, 'utf8')).toBe(project);
    expect(readFileSync(files.template_file, 'utf8')).toBe(template);
  });

  it.each(['>-', '|', '$(inherited) -ObjC # preserve this comment', '["$(inherited)"] # preserve this comment'])('leaves files intact for unsupported linker syntax: %s', (flags) => {
    const template = template_fixture.replace('        DEVELOPMENT_TEAM', `        OTHER_LDFLAGS: ${flags}\n        DEVELOPMENT_TEAM`);
    const files = createProject(project_fixture, template);
    expect(() => prepareXcodeProject(files.apple_directory, ['/stable/node/bin'])).toThrow(/inline Xcode linker flags/);
    expect(readFileSync(files.project_file, 'utf8')).toBe(project_fixture);
    expect(readFileSync(files.template_file, 'utf8')).toBe(template);
  });
});
