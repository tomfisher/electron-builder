import BluebirdPromise from "bluebird-lst"
import { Arch, asArray, AsyncTaskManager, debug, DebugLogger, deepAssign, executeAppBuilder, getArchSuffix, InvalidConfigurationError, isEmptyOrSpaces, log } from "builder-util"
import { PackageBuilder } from "builder-util/out/api"
import { FileTransformer, statOrNull } from "builder-util/out/fs"
import { orIfFileNotExist } from "builder-util/out/promise"
import { readdir } from "fs-extra-p"
import { Lazy } from "lazy-val"
import { Minimatch } from "minimatch"
import * as path from "path"
import { AppInfo } from "./appInfo"
import { checkFileInArchive } from "./asar/asarFileChecker"
import { AsarPackager } from "./asar/asarUtil"
import { computeData } from "./asar/integrity"
import { copyFiles, FileMatcher, getFileMatchers, GetFileMatchersOptions, getMainFileMatchers, getNodeModuleFileMatcher } from "./fileMatcher"
import { createTransformer, isElectronCompileUsed } from "./fileTransformer"
import { isElectronBased } from "./Framework"
import { PackagerOptions, Packager, AfterPackContext, AsarOptions, Configuration, ElectronPlatformName, FileAssociation, PlatformSpecificBuildOptions, CompressionLevel, Platform, Target, TargetSpecificOptions } from "./index"
import { copyAppFiles, transformFiles, computeFileSets, computeNodeModuleFileSets, ELECTRON_COMPILE_SHIM_FILENAME } from "./util/appFileCopier"
import { expandMacro as doExpandMacro } from "./util/macroExpander"

export abstract class PlatformPackager<DC extends PlatformSpecificBuildOptions> implements PackageBuilder {
  get packagerOptions(): PackagerOptions {
    return this.info.options
  }

  get buildResourcesDir(): string {
    return this.info.buildResourcesDir
  }

  get projectDir(): string {
    return this.info.projectDir
  }

  get config(): Configuration {
    return this.info.config
  }

  readonly platformSpecificBuildOptions: DC

  get resourceList(): Promise<Array<string>> {
    return this._resourceList.value
  }

  private readonly _resourceList = new Lazy<Array<string>>(() => orIfFileNotExist(readdir(this.info.buildResourcesDir), []))

  readonly appInfo: AppInfo

  protected constructor(readonly info: Packager, readonly platform: Platform) {
    this.platformSpecificBuildOptions = PlatformPackager.normalizePlatformSpecificBuildOptions((this.config as any)[platform.buildConfigurationKey])
    this.appInfo = this.prepareAppInfo(info.appInfo)
  }

  get compression(): CompressionLevel {
    const compression = this.platformSpecificBuildOptions.compression
    // explicitly set to null - request to use default value instead of parent (in the config)
    if (compression === null) {
      return "normal"
    }
    return compression || this.config.compression || "normal"
  }

  get debugLogger(): DebugLogger {
    return this.info.debugLogger
  }

  abstract get defaultTarget(): Array<string>

  protected prepareAppInfo(appInfo: AppInfo) {
    return appInfo
  }

  private static normalizePlatformSpecificBuildOptions(options: any | null | undefined): any {
    return options == null ? Object.create(null) : options
  }

  abstract createTargets(targets: Array<string>, mapper: (name: string, factory: (outDir: string) => Target) => void): void

  protected getCscPassword(): string {
    const password = this.doGetCscPassword()
    if (isEmptyOrSpaces(password)) {
      log.info({reason: "CSC_KEY_PASSWORD is not defined"}, "empty password will be used for code signing")
      return ""
    }
    else {
      return password!.trim()
    }
  }

  protected getCscLink(extraEnvName?: string | null): string | null | undefined {
    // allow to specify as empty string
    const envValue = chooseNotNull(extraEnvName == null ? null : process.env[extraEnvName], process.env.CSC_LINK)
    return chooseNotNull(chooseNotNull(this.info.config.cscLink, this.platformSpecificBuildOptions.cscLink), envValue)
  }

  protected doGetCscPassword(): string | null | undefined {
    // allow to specify as empty string
    return chooseNotNull(chooseNotNull(this.info.config.cscKeyPassword, this.platformSpecificBuildOptions.cscKeyPassword), process.env.CSC_KEY_PASSWORD)
  }

  protected computeAppOutDir(outDir: string, arch: Arch): string {
    return this.packagerOptions.prepackaged || path.join(outDir, `${this.platform.buildConfigurationKey}${getArchSuffix(arch)}${this.platform === Platform.MAC ? "" : "-unpacked"}`)
  }

  dispatchArtifactCreated(file: string, target: Target | null, arch: Arch | null, safeArtifactName?: string | null) {
    this.info.dispatchArtifactCreated({
      file, safeArtifactName, target, arch,
      packager: this,
    })
  }

  async pack(outDir: string, arch: Arch, targets: Array<Target>, taskManager: AsyncTaskManager): Promise<any> {
    const appOutDir = this.computeAppOutDir(outDir, arch)
    await this.doPack(outDir, appOutDir, this.platform.nodeName as ElectronPlatformName, arch, this.platformSpecificBuildOptions, targets)
    this.packageInDistributableFormat(appOutDir, arch, targets, taskManager)
  }

  protected packageInDistributableFormat(appOutDir: string, arch: Arch, targets: Array<Target>, taskManager: AsyncTaskManager): void {
    if (targets.find(it => !it.isAsyncSupported) == null) {
      PlatformPackager.buildAsyncTargets(targets, taskManager, appOutDir, arch)
      return
    }

    taskManager.add(async () => {
      // BluebirdPromise.map doesn't invoke target.build immediately, but for RemoteTarget it is very critical to call build() before finishBuild()
      const subTaskManager = new AsyncTaskManager(this.info.cancellationToken)
      PlatformPackager.buildAsyncTargets(targets, subTaskManager, appOutDir, arch)
      await subTaskManager.awaitTasks()

      for (const target of targets) {
        if (!target.isAsyncSupported) {
          await target.build(appOutDir, arch)
        }
      }
    })
  }

  private static buildAsyncTargets(targets: Array<Target>, taskManager: AsyncTaskManager, appOutDir: string, arch: Arch) {
    for (const target of targets) {
      if (target.isAsyncSupported) {
        taskManager.addTask(target.build(appOutDir, arch))
      }
    }
  }

  private getExtraFileMatchers(isResources: boolean, appOutDir: string, options: GetFileMatchersOptions): Array<FileMatcher> | null {
    const base = isResources ? this.getResourcesDir(appOutDir) : (this.platform === Platform.MAC ? path.join(appOutDir, `${this.appInfo.productFilename}.app`, "Contents") : appOutDir)
    return getFileMatchers(this.config, isResources ? "extraResources" : "extraFiles", this.projectDir, base, options)
  }

  get electronDistExecutableName() {
    return this.config.muonVersion == null ? "electron" : "brave"
  }

  get electronDistMacOsExecutableName() {
    return this.config.muonVersion == null ? "Electron" : "Brave"
  }

  protected async doPack(outDir: string, appOutDir: string, platformName: ElectronPlatformName, arch: Arch, platformSpecificBuildOptions: DC, targets: Array<Target>) {
    if (this.packagerOptions.prepackaged != null) {
      return
    }

    const macroExpander = (it: string) => this.expandMacro(it, arch == null ? null : Arch[arch], {"/*": "{,/**/*}"})

    const framework = this.info.framework
    log.info({
      platform: platformName,
      arch: Arch[arch],
      [`${framework.name}`]: framework.version,
      appOutDir: log.filePath(appOutDir),
    }, `packaging`)

    await framework.prepareApplicationStageDirectory({
      packager: this,
      appOutDir,
      platformName,
      arch: Arch[arch],
      version: framework.version,
    })

    const excludePatterns: Array<Minimatch> = []

    const computeParsedPatterns = (patterns: Array<FileMatcher> | null) => {
      if (patterns != null) {
        for (const pattern of patterns) {
          pattern.computeParsedPatterns(excludePatterns, this.info.projectDir)
        }
      }
    }

    const getFileMatchersOptions: GetFileMatchersOptions = {
      macroExpander,
      customBuildOptions: platformSpecificBuildOptions,
      outDir,
    }
    const extraResourceMatchers = this.getExtraFileMatchers(true, appOutDir, getFileMatchersOptions)
    computeParsedPatterns(extraResourceMatchers)
    const extraFileMatchers = this.getExtraFileMatchers(false, appOutDir, getFileMatchersOptions)
    computeParsedPatterns(extraFileMatchers)

    const packContext: AfterPackContext = {
      appOutDir, outDir, arch, targets,
      packager: this,
      electronPlatformName: platformName,
    }

    const asarOptions = await this.computeAsarOptions(platformSpecificBuildOptions)
    const resourcesPath = this.platform === Platform.MAC ? path.join(appOutDir, framework.distMacOsAppName, "Contents", "Resources") : (isElectronBased(framework) ? path.join(appOutDir, "resources") : appOutDir)
    const taskManager = new AsyncTaskManager(this.info.cancellationToken)
    this.copyAppFiles(taskManager, asarOptions, resourcesPath, path.join(resourcesPath, "app"), packContext, platformSpecificBuildOptions, excludePatterns, macroExpander)
    await taskManager.awaitTasks()

    if (this.info.cancellationToken.cancelled) {
      return
    }

    const beforeCopyExtraFiles = this.info.framework.beforeCopyExtraFiles
    if (beforeCopyExtraFiles != null) {
      await beforeCopyExtraFiles(this, appOutDir, asarOptions == null ? null : await computeData(resourcesPath, asarOptions.externalAllowed ? {externalAllowed: true} : null))
    }

    const transformerForExtraFiles = this.createTransformerForExtraFiles(packContext)
    await copyFiles(extraResourceMatchers, transformerForExtraFiles)
    await copyFiles(extraFileMatchers, transformerForExtraFiles)

    if (this.info.cancellationToken.cancelled) {
      return
    }

    await this.info.afterPack(packContext)
    const isAsar = asarOptions != null
    await this.sanityCheckPackage(appOutDir, isAsar)
    await this.signApp(packContext, isAsar)
    await this.info.afterSign(packContext)
  }

  protected createTransformerForExtraFiles(packContext: AfterPackContext): FileTransformer | null {
    return null
  }

  private copyAppFiles(taskManager: AsyncTaskManager, asarOptions: AsarOptions | null, resourcePath: string, defaultDestination: string, packContext: AfterPackContext, platformSpecificBuildOptions: DC, excludePatterns: Array<Minimatch>, macroExpander: ((it: string) => string)) {
    const appDir = this.info.appDir
    const config = this.config
    const isElectronCompile = asarOptions != null && isElectronCompileUsed(this.info)

    const mainMatchers = getMainFileMatchers(appDir, defaultDestination, macroExpander, platformSpecificBuildOptions, this, packContext.outDir, isElectronCompile)
    if (excludePatterns.length > 0) {
      for (const matcher of mainMatchers) {
        matcher.excludePatterns = excludePatterns
      }
    }

    const framework = this.info.framework
    const transformer = createTransformer(appDir, config, isElectronCompile ? {
      originalMain: this.info.metadata.main,
      main: ELECTRON_COMPILE_SHIM_FILENAME,
      ...config.extraMetadata
    } : config.extraMetadata, framework.createTransformer == null ? null : framework.createTransformer())

    const _computeFileSets = (matchers: Array<FileMatcher>) => {
      return computeFileSets(matchers, this.info.isPrepackedAppAsar ? null : transformer, this, isElectronCompile)
        .then(async result => {
          if (!this.info.isPrepackedAppAsar && !this.info.areNodeModulesHandledExternally) {
            const moduleFileMatcher = getNodeModuleFileMatcher(appDir, defaultDestination, macroExpander, platformSpecificBuildOptions, this.info)
            result = result.concat(await computeNodeModuleFileSets(this, moduleFileMatcher))
          }
          return result.filter(it => it.files.length > 0)
        })
    }

    if (this.info.isPrepackedAppAsar) {
      taskManager.addTask(BluebirdPromise.each(_computeFileSets([new FileMatcher(appDir, resourcePath, macroExpander)]), it => copyAppFiles(it, this.info, transformer)))
    }
    else if (asarOptions == null) {
      // for ASAR all asar unpacked files will be extra transformed (e.g. sign of EXE and DLL) later,
      // for prepackaged asar extra transformation not supported yet,
      // so, extra transform if asar is disabled
      const transformerForExtraFiles = this.createTransformerForExtraFiles(packContext)
      const combinedTransformer: FileTransformer = file => {
        if (transformerForExtraFiles != null) {
          const result = transformerForExtraFiles(file)
          if (result != null) {
            return result
          }
        }
        return transformer(file)
      }

      taskManager.addTask(BluebirdPromise.each(_computeFileSets(mainMatchers), it => copyAppFiles(it, this.info, combinedTransformer)))
    }
    else {
      const unpackPattern = getFileMatchers(config, "asarUnpack", appDir, defaultDestination, {
        macroExpander,
        customBuildOptions: platformSpecificBuildOptions,
        outDir: packContext.outDir,
      })
      const fileMatcher = unpackPattern == null ? null : unpackPattern[0]
      taskManager.addTask(_computeFileSets(mainMatchers)
        .then(async fileSets => {
          for (const fileSet of fileSets) {
            await transformFiles(transformer, fileSet)
          }

          await new AsarPackager(appDir, resourcePath, asarOptions, fileMatcher == null ? null : fileMatcher.createFilter())
            .pack(fileSets, this)
        }))
    }
  }

  protected signApp(packContext: AfterPackContext, isAsar: boolean): Promise<any> {
    return Promise.resolve()
  }

  async getIconPath(): Promise<string | null> {
    return null
  }

  private async computeAsarOptions(customBuildOptions: DC): Promise<AsarOptions | null> {
    if (!isElectronBased(this.info.framework)) {
      return null
    }

    function errorMessage(name: string) {
      return `${name} is deprecated is deprecated and not supported — please use asarUnpack`
    }

    const buildMetadata = this.config as any
    if (buildMetadata["asar-unpack"] != null) {
      throw new Error(errorMessage("asar-unpack"))
    }
    if (buildMetadata["asar-unpack-dir"] != null) {
      throw new Error(errorMessage("asar-unpack-dir"))
    }

    const platformSpecific = customBuildOptions.asar
    const result = platformSpecific == null ? this.config.asar : platformSpecific
    if (result === false) {
      const appAsarStat = await statOrNull(path.join(this.info.appDir, "app.asar"))
      //noinspection ES6MissingAwait
      if (appAsarStat == null || !appAsarStat.isFile()) {
        log.warn({
          solution: "enable asar and use asarUnpack to unpack files that must be externally available",
        }, "asar using is disabled — it is strongly not recommended")
      }
      return null
    }

    if (result == null || result === true) {
      return {}
    }

    for (const name of ["unpackDir", "unpack"]) {
      if ((result as any)[name] != null) {
        throw new Error(errorMessage(`asar.${name}`))
      }
    }
    return deepAssign({}, result)
  }

  public getElectronSrcDir(dist: string): string {
    return path.resolve(this.projectDir, dist)
  }

  public getElectronDestinationDir(appOutDir: string): string {
    return appOutDir
  }

  getResourcesDir(appOutDir: string): string {
    if (this.platform === Platform.MAC) {
      return this.getMacOsResourcesDir(appOutDir)
    }
    else if (isElectronBased(this.info.framework)) {
      return path.join(appOutDir, "resources")
    }
    else {
      return appOutDir
    }
  }

  public getMacOsResourcesDir(appOutDir: string): string {
    return path.join(appOutDir, `${this.appInfo.productFilename}.app`, "Contents", "Resources")
  }

  private async checkFileInPackage(resourcesDir: string, file: string, messagePrefix: string, isAsar: boolean) {
    const relativeFile = path.relative(this.info.appDir, path.resolve(this.info.appDir, file))
    if (isAsar) {
      await checkFileInArchive(path.join(resourcesDir, "app.asar"), relativeFile, messagePrefix)
      return
    }

    const pathParsed = path.parse(file)
    // Even when packaging to asar is disabled, it does not imply that the main file can not be inside an .asar archive.
    // This may occur when the packaging is done manually before processing with electron-builder.
    if (pathParsed.dir.includes(".asar")) {
      // The path needs to be split to the part with an asar archive which acts like a directory and the part with
      // the path to main file itself. (e.g. path/arch.asar/dir/index.js -> path/arch.asar, dir/index.js)
      // noinspection TypeScriptValidateJSTypes
      const pathSplit: Array<string> = pathParsed.dir.split(path.sep)
      let partWithAsarIndex = 0
      pathSplit.some((pathPart: string, index: number) => {
        partWithAsarIndex = index
        return pathPart.endsWith(".asar")
      })
      const asarPath = path.join.apply(path, pathSplit.slice(0, partWithAsarIndex + 1))
      let mainPath = pathSplit.length > (partWithAsarIndex + 1) ? path.join.apply(pathSplit.slice(partWithAsarIndex + 1)) : ""
      mainPath += path.join(mainPath, pathParsed.base)
      await checkFileInArchive(path.join(resourcesDir, "app", asarPath), mainPath, messagePrefix)
    }
    else {
      const outStat = await statOrNull(path.join(resourcesDir, "app", relativeFile))
      if (outStat == null) {
        throw new Error(`${messagePrefix} "${relativeFile}" does not exist. Seems like a wrong configuration.`)
      }
      else {
        //noinspection ES6MissingAwait
        if (!outStat.isFile()) {
          throw new Error(`${messagePrefix} "${relativeFile}" is not a file. Seems like a wrong configuration.`)
        }
      }
    }
  }

  private async sanityCheckPackage(appOutDir: string, isAsar: boolean): Promise<any> {
    const outStat = await statOrNull(appOutDir)
    if (outStat == null) {
      throw new Error(`Output directory "${appOutDir}" does not exist. Seems like a wrong configuration.`)
    }
    else {
      //noinspection ES6MissingAwait
      if (!outStat.isDirectory()) {
        throw new Error(`Output directory "${appOutDir}" is not a directory. Seems like a wrong configuration.`)
      }
    }

    const resourcesDir = this.getResourcesDir(appOutDir)
    await this.checkFileInPackage(resourcesDir, this.info.metadata.main || "index.js", "Application entry file", isAsar)
    await this.checkFileInPackage(resourcesDir, "package.json", "Application", isAsar)
  }

  // tslint:disable-next-line:no-invalid-template-strings
  computeSafeArtifactName(suggestedName: string | null, ext: string, arch?: Arch | null, skipArchIfX64 = true, safePattern: string = "${name}-${version}-${arch}.${ext}"): string | null {
    // GitHub only allows the listed characters in file names.
    if (suggestedName != null && isSafeGithubName(suggestedName)) {
      return null
    }

    return this.computeArtifactName(safePattern, ext, skipArchIfX64 && arch === Arch.x64 ? null : arch)
  }

  expandArtifactNamePattern(targetSpecificOptions: TargetSpecificOptions | null | undefined, ext: string, arch?: Arch | null, defaultPattern?: string, skipArchIfX64 = true): string {
    let pattern = targetSpecificOptions == null ? null : targetSpecificOptions.artifactName
    if (pattern == null) {
      // tslint:disable-next-line:no-invalid-template-strings
      pattern = this.platformSpecificBuildOptions.artifactName || this.config.artifactName || defaultPattern || "${productName}-${version}-${arch}.${ext}"
    }
    return this.computeArtifactName(pattern, ext, skipArchIfX64 && arch === Arch.x64 ? null : arch)
  }

  private computeArtifactName(pattern: any, ext: string, arch: Arch | null | undefined) {
    let archName: string | null = arch == null ? null : Arch[arch]
    if (arch === Arch.x64) {
      if (ext === "AppImage" || ext === "rpm") {
        archName = "x86_64"
      }
      else if (ext === "deb" || ext === "snap") {
        archName = "amd64"
      }
    }
    else if (arch === Arch.ia32) {
      if (ext === "deb" || ext === "AppImage" || ext === "snap") {
        archName = "i386"
      }
      else if (ext === "pacman" || ext === "rpm") {
        archName = "i686"
      }
    }

    return this.expandMacro(pattern, this.platform === Platform.MAC ? null : archName, {
      ext
    })
  }

  expandMacro(pattern: string, arch?: string | null, extra: any = {}, isProductNameSanitized = true): string {
    return doExpandMacro(pattern, arch, this.appInfo, {os: this.platform.buildConfigurationKey, ...extra}, isProductNameSanitized)
  }

  generateName2(ext: string | null, classifier: string | null | undefined, deployment: boolean): string {
    const dotExt = ext == null ? "" : `.${ext}`
    const separator = ext === "deb" ? "_" : "-"
    return `${deployment ? this.appInfo.name : this.appInfo.productFilename}${separator}${this.appInfo.version}${classifier == null ? "" : `${separator}${classifier}`}${dotExt}`
  }

  getTempFile(suffix: string): Promise<string> {
    return this.info.tempDirManager.getTempFile({suffix})
  }

  get fileAssociations(): Array<FileAssociation> {
    return asArray(this.config.fileAssociations).concat(asArray(this.platformSpecificBuildOptions.fileAssociations))
  }

  async getResource(custom: string | null | undefined, ...names: Array<string>): Promise<string | null> {
    const resourcesDir = this.info.buildResourcesDir
    if (custom === undefined) {
      const resourceList = await this.resourceList
      for (const name of names) {
        if (resourceList.includes(name)) {
          return path.join(resourcesDir, name)
        }
      }
    }
    else if (custom != null && !isEmptyOrSpaces(custom)) {
      const resourceList = await this.resourceList
      if (resourceList.includes(custom)) {
        return path.join(resourcesDir, custom)
      }

      let p = path.resolve(resourcesDir, custom)
      if (await statOrNull(p) == null) {
        p = path.resolve(this.projectDir, custom)
        if (await statOrNull(p) == null) {
          throw new InvalidConfigurationError(`cannot find specified resource "${custom}", nor relative to "${resourcesDir}", neither relative to project dir ("${this.projectDir}")`)
        }
      }
      return p
    }
    return null
  }

  get forceCodeSigning(): boolean {
    const forceCodeSigningPlatform = this.platformSpecificBuildOptions.forceCodeSigning
    return (forceCodeSigningPlatform == null ? this.config.forceCodeSigning : forceCodeSigningPlatform) || false
  }

  protected async getOrConvertIcon(format: IconFormat): Promise<string | null> {
    const sourceNames = [`icon.${format === "set" ? "png" : format}`, "icon.png", "icons"]

    const iconPath = this.platformSpecificBuildOptions.icon || this.config.icon
    if (iconPath != null) {
      sourceNames.unshift(iconPath)
    }

    if (format === "ico") {
      sourceNames.push("icon.icns")
    }

    const result = await this.resolveIcon(sourceNames, format)
    if (result.length === 0) {
      const framework = this.info.framework
      if (framework.getDefaultIcon != null) {
        return framework.getDefaultIcon(this.platform)
      }

      log.warn({reason: "application icon is not set"}, framework.isDefaultAppIconProvided ? `default ${capitalizeFirstLetter(framework.name)} icon is used` : `application doesn't have an icon`)
      return null
    }
    else {
      return result[0].file
    }
  }

  // convert if need, validate size (it is a reason why tool is called even if file has target extension (already specified as foo.icns for example))
  async resolveIcon(sources: Array<string>, outputFormat: IconFormat): Promise<Array<IconInfo>> {
    const args = [
      "icon",
      "--format", outputFormat,
      "--root", this.buildResourcesDir,
      "--root", this.projectDir,
      "--out", path.resolve(this.projectDir, this.config.directories!!.output!!, `.icon-${outputFormat}`),
    ]
    for (const source of sources) {
      args.push("--input", source)
    }

    const rawResult = await executeAppBuilder(args)
    let result: IconConvertResult
    try {
      result = JSON.parse(rawResult)
    }
    catch (e) {
      throw new Error(`Cannot parse result: ${e.message}: ${rawResult}`)
    }

    const errorMessage = result.error
    if (errorMessage != null) {
      throw new InvalidConfigurationError(errorMessage, result.errorCode)
    }
    return result.icons || []
  }
}

export interface IconInfo {
  file: string
  size: number
}

interface IconConvertResult {
  icons?: Array<IconInfo>

  error?: string
  errorCode?: string
}

export type IconFormat = "icns" | "ico" | "set"

export function isSafeGithubName(name: string) {
  return /^[0-9A-Za-z._-]+$/.test(name)
}

// remove leading dot
export function normalizeExt(ext: string) {
  return ext.startsWith(".") ? ext.substring(1) : ext
}

export function resolveFunction<T>(executor: T | string): T {
  if (executor == null || typeof executor !== "string") {
    return executor
  }

  let p = executor as string
  if (p.startsWith(".")) {
    p = path.resolve(p)
  }
  try {
    p = require.resolve(p)
  }
  catch (e) {
    debug(e)
    p = path.resolve(p)
  }

  const m = require(p)
  return m.default || m
}

export function chooseNotNull(v1: string | null | undefined, v2: string | null | undefined): string | null | undefined {
  return v1 == null ? v2 : v1
}

function capitalizeFirstLetter(text: string) {
  return text.charAt(0).toUpperCase() + text.slice(1)
}