/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        ZettlrConfig class
 * CVM-Role:        Model
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This class fulfills two basic tasks: (1) Manage the app's
 *                  configuration, stored in the config.json inside the user
 *                  data directory. (2) Check the environment whether or not
 *                  specific conditions exist (such as the pandoc or xelatex
 *                  binaries)
 *
 * END HEADER
 */

const fs = require('fs')
const path = require('path')
const uuid = require('uuid/v5')
const EventEmitter = require('events')
const ZettlrValidation = require('../common/zettlr-validation.js')
const { app } = require('electron')
const { ignoreFile, isDir, isDictAvailable } = require('../common/zettlr-helpers.js')
const COMMON_DATA = require('../common/data.json')

/**
 * This class represents the configuration of Zettlr, represented by the
 * config.json file in the user's data directory as well as some environment
 * variables. Basically, this class tells Zettlr what the user wants and what
 * the environment Zettlr is running in is capable of.
 */
class ZettlrConfig extends EventEmitter {
  /**
    * Preset sane defaults, then load the config and perform a system check.
    * @param {Zettlr} parent Parent Zettlr object.
    */
  constructor (parent) {
    super() // Initiate the emitter
    this.parent = parent
    this.configPath = app.getPath('userData')
    this.configFile = path.join(this.configPath, 'config.json')
    this.config = null
    this._rules = [] // This array holds all validation rules

    // Additional environmental paths (for locating LaTeX and Pandoc)
    if (process.platform === 'win32') {
      this._additional_paths = COMMON_DATA.additional_paths.win32
    } else if (process.platform === 'linux') {
      this._additional_paths = COMMON_DATA.additional_paths.linux
    } else if (process.platform === 'darwin') {
      this._additional_paths = COMMON_DATA.additional_paths.macos
    } else {
      this._additional_paths = [] // Fallback: No additional paths
    }

    // Config Template providing all necessary arguments
    this.cfgtpl = {
      // Root directories
      'openPaths': [],
      'dialogPaths': {
        'askFileDialog': '',
        'askDirDialog': '',
        'askLangFileDialog': ''
      },
      'window': {
        'x': 0,
        'y': 0,
        'width': require('electron').screen.getPrimaryDisplay().workAreaSize.width,
        'height': require('electron').screen.getPrimaryDisplay().workAreaSize.width,
        'max': true
      },
      'lastFile': null, // Save last opened file hash here
      'lastDir': null, // Save last opened dir hash here
      // Visible attachment filetypes
      'attachmentExtensions': COMMON_DATA.attachmentExtensions,
      // UI related options
      'darkTheme': false,
      'snippets': false,
      'muteLines': true, // Should the editor mute lines in distraction free mode?
      'combinerState': 'collapsed', // collapsed = Preview or directories visible --- expanded = both visible
      // Export options
      'pandoc': 'pandoc',
      'xelatex': 'xelatex',
      'export': {
        'dir': 'temp', // Can either be "temp" or "cwd" (current working directory)
        'stripIDs': true, // Strip ZKN IDs such as @ID:<id>
        'stripTags': false, // Strip tags a.k.a. #tag
        'stripLinks': 'full', // Strip internal links: "full" - remove completely, "unlink" - only remove brackets, "no" - don't alter
        'cslLibrary': '', // Path to a CSL JSON library file
        'cslStyle': '' // Path to a CSL Style file
      },
      // PDF options (for all documents; projects will copy this object over)
      'pdf': {
        'author': 'Generated by Zettlr', // Default user name
        'keywords': '', // PDF keywords
        'papertype': 'a4paper', // Paper to use, e.g. A4 or Letter
        'pagenumbering': 'gobble', // By default omit page numbers
        'tmargin': 3, // Margins to paper (top, right, bottom, left)
        'rmargin': 3,
        'bmargin': 3,
        'lmargin': 3,
        'margin_unit': 'cm',
        'lineheight': '1.5', // Default: 150% line height
        'mainfont': 'Times New Roman', // Main font
        'sansfont': 'Arial', // Sans font, used, e.g. for headings
        'fontsize': 12 // Will be translated to pt
      },
      // Zettelkasten stuff (IDs, as well as link matchers)
      'zkn': {
        'idRE': '(\\d{14})',
        'idGen': '%Y%M%D%h%m%s',
        'linkStart': '[[',
        'linkEnd': ']]'
      },
      // Editor related stuff
      'editor': {
        'autoCloseBrackets': true
      },
      // Language
      'selectedDicts': [ ], // By default no spell checking is active to speed up first start.
      'app_lang': this.getLocale(),
      'debug': false,
      'uuid': null // The app's unique anonymous identifier
    }

    // Load the configuration
    this.load()

    // Run system check
    this.checkSystem()

    // Remove potential dead links to non-existent files and dirs
    this.checkPaths()

    // Boot up the validation rules
    let rules = require('../common/validation.json')
    for (let key in rules) {
      this._rules.push(new ZettlrValidation(key, rules[key]))
    }

    // Put the attachment extensions into the global so that the helper
    // function isAttachment() can grab them
    global.attachmentExtensions = this.config.attachmentExtensions

    // Put a global setter and getter for config keys into the globals.
    global.config = {
      get: (key) => {
        // Clone the properties to prevent intrusion
        return JSON.parse(JSON.stringify(this.get(key)))
      },
      // The setter is a simply pass-through
      set: (key, val) => {
        return this.set(key, val)
      },
      // Enable global event listening to updates of the config
      on: (evt, callback) => {
        this.on(evt, callback)
      },
      // Also do the same for the removal of listeners
      off: (evt, callback) => {
        this.off(evt, callback)
      }
    }
  }

  /**
    * This function only (re-)reads the configuration file if present
    * @return {ZettlrConfig} This for chainability.
    */
  load () {
    this.config = this.cfgtpl
    let readConfig = {}

    // Check if dir exists. If not, create.
    try {
      fs.lstatSync(this.configPath)
    } catch (e) {
      fs.mkdirSync(this.configPath)
    }

    // Does the file already exist?
    try {
      fs.lstatSync(this.configFile)
      readConfig = JSON.parse(fs.readFileSync(this.configFile, { encoding: 'utf8' }))
    } catch (e) {
      fs.writeFileSync(this.configFile, JSON.stringify(this.cfgtpl), { encoding: 'utf8' })
      return this // No need to iterate over objects anymore
    }

    this.update(readConfig)

    return this
  }

  /**
    * Write the config file (e.g. on app exit)
    * @return {ZettlrConfig} This for chainability.
    */
  save () {
    if (this.configFile == null || this.config == null) {
      this.load()
    }
    // (Over-)write the configuration
    fs.writeFileSync(this.configFile, JSON.stringify(this.config), { encoding: 'utf8' })

    return this
  }

  /**
    * This function runs a general environment check and tries to determine
    * some environment variables (such as the existence of pandoc or xelatex)
    * @return {ZettlrConfig} This for chainability.
    */
  checkSystem () {
    let delim = (process.platform === 'win32') ? ';' : ':'

    if (this._additional_paths.length > 0) {
      // First integrate the additional paths that we need.
      let nPATH = process.env.PATH.split(delim)

      for (let x of this._additional_paths) {
        // Check for both trailing and non-trailing slashes (to not add any
        // directory more than once)
        let y = (x[x.length - 1] === '/') ? x.substr(0, x.length - 1) : x + '/'
        if (!nPATH.includes(x) && !nPATH.includes(y)) {
          nPATH.push(x)
        }
      }

      process.env.PATH = nPATH.join(delim)
    }

    // Also add to PATH xelatex and pandoc-directories if these variables
    // contain actual dirs.
    if (path.dirname(this.get('xelatex')).length > 0) {
      if (process.env.PATH.indexOf(path.dirname(this.get('xelatex'))) === -1) {
        process.env.PATH += delim + path.dirname(this.get('xelatex'))
      }
    }

    if (path.dirname(this.get('pandoc')).length > 0) {
      if (process.env.PATH.indexOf(path.dirname(this.get('pandoc'))) === -1) {
        process.env.PATH += delim + path.dirname(this.get('pandoc'))
      }
    }

    // Finally, check whether or not a UUID exists, and, if not, generate one.
    if (!this.config.uuid) {
      this.config.uuid = uuid('com.zettlr.app', uuid.DNS)
    }

    return this
  }

  /**
    * Checks the validity of each path that should be opened and removes all
    * those that are invalid
    * @return {void} Nothing to return.
    */
  checkPaths () {
    // First check if the dict directory exists and create, if not.
    try {
      fs.lstatSync(path.join(this.configPath, 'dict'))
    } catch (e) {
      fs.mkdirSync(path.join(this.configPath, 'dict'))
    }

    for (let i = 0; i < this.config['openPaths'].length; i++) {
      try {
        fs.lstatSync(this.config['openPaths'][i])
      } catch (e) {
        // Remove the path
        this.config['openPaths'].splice(i, 1)
        --i
      }
    }

    // Remove duplicates
    this.config['openPaths'] = [...new Set(this.config['openPaths'])]

    // Now sort the paths.
    this._sortPaths()

    // We have to run over the spellchecking dictionaries and see whether or
    // not they are still valid or if they have been deleted.
    for (let i = 0; i < this.config['selectedDicts'].length; i++) {
      if (!isDictAvailable(this.config['selectedDicts'][i])) {
        this.config['selectedDicts'].splice(i, 1)
        --i
      }
    }
  }

  /**
    * Adds a path to be opened on startup
    * @param {String} p The path to be added
    * @return {Boolean} True, if the path was succesfully added, else false.
    */
  addPath (p) {
    // Only add valid and unique paths
    if ((!ignoreFile(p) || isDir(p)) && !this.config['openPaths'].includes(p)) {
      this.config['openPaths'].push(p)
      this._sortPaths()
      return true
    }

    return false
  }

  /**
    * Removes a path from the startup paths
    * @param  {String} p The path to be removed
    */
  removePath (p) {
    if (this.config['openPaths'].includes(p)) {
      this.config['openPaths'].splice(this.config['openPaths'].indexOf(p), 1)
    }
  }

  /**
    * Returns a config property
    * @param  {String} attr The property to return
    * @return {Mixed}      Either the config property or null
    */
  get (attr) {
    if (!attr) {
      // If no attribute is given, simply return the complete config object.
      return this.getConfig()
    }

    if (attr.indexOf('.') > 0) {
      // A nested argument was requested, so iterate until we find it
      let nested = attr.split('.')
      let cfg = this.config
      for (let arg of nested) {
        if (cfg.hasOwnProperty(arg)) {
          cfg = cfg[arg]
        } else {
          return null // The config option must match exactly
        }
      }

      return cfg // Now not the requested config option.
    }

    // Plain attribute requested
    if (this.config.hasOwnProperty(attr)) {
      return this.config[attr]
    } else {
      return null
    }
  }

  /**
    * Simply returns the complete config object.
    * @return {Object} The configuration object.
    */
  getConfig () {
    return this.config
  }

  /**
    * Returns the language (but always specified in the form <main>_<sub>,
    * b/c we rely on it). If no "sub language" is given (e.g. only en, fr or de),
    * then we assume the primary language (e.g. this function returns en_US for en,
    * fr_FR for fr and de_DE for de. And yes, I know that British people won't
    * like me for that. I'm sorry.)
    * @return {String} The user's locale
    */
  getLocale () {
    let lang = app.getLocale()
    let mainlang = null

    if (lang.indexOf('-') > -1) {
      // Specific sub-lang
      mainlang = lang.split('-')[0]
      lang = lang.split('-')[1]
    } else {
      // Only mainlang
      mainlang = lang
      lang = null
    }

    for (let sup of this.getSupportedLangs()) {
      let ml = sup.split('_')[0]
      let sl = sup.split('_')[1]
      if (ml === mainlang) {
        if (lang === null) {
          return sup
        } else {
          if (sl === lang) {
            return sup
          }
        }
      }
    }

    return 'en_US' // Fallback default
  }

  /**
    * Return all supported languages.
    * @return {Array} An array containing all allowed language codes.
    */
  getSupportedLangs () {
    // First dynamically enumerate all files that come shipped with the app.
    let files = fs.readdirSync(path.join(__dirname, '../common/lang'))
    let languageFiles = []
    for (let f of files) {
      if (/[a-z]{1,3}_[A-Z]{1,3}\.json/.test(f)) { // Minimum: aa_AA.json, maximum: aaa_AAA.json
        // It's a language file!
        languageFiles.push(f.substr(0, f.lastIndexOf('.')))
      }
    }

    // Secondly, enumerate all user translations. Path: APP_DATA/lang
    try {
      files = fs.readdirSync(path.join(this.configPath, '/lang'))
      for (let f of files) {
        if (/[a-z]{1,3}_[A-Z]{1,3}\.json/.test(f)) {
          // It's a language file!
          languageFiles.push(f.substr(0, f.lastIndexOf('.')))
        }
      }
    } catch (e) {
      // If something goes wrong, simply don't include any user files.
    }

    return languageFiles
  }

  /**
    * This function dynamically generates an array of all available dictionaries.
    * @return {Array} An array containing all language codes available.
    */
  getDictionaries () {
    // First dynamically enumerate all files that come shipped with the app.
    let scanfolder = path.join(__dirname, './assets/dict')
    let dirs = fs.readdirSync(scanfolder)
    let dictLangs = []
    for (let d of dirs) {
      if (/^[a-z]{1,3}_[A-Z]{1,3}$/.test(d) && isDir(path.join(scanfolder, d)) && isDictAvailable(d)) {
        // It's a dict dir!
        dictLangs.push(d)
      }
    }

    // Secondly, enumerate all custom dicts. Path: APP_DATA/dict
    try {
      scanfolder = path.join(this.configPath, '/dict')
      dirs = fs.readdirSync(scanfolder)
      for (let d of dirs) {
        if (/^[a-z]{1,3}_[A-Z]{1,3}$/.test(d) && isDir(path.join(scanfolder, d)) && isDictAvailable(d)) {
          // It's a dict dir!
          dictLangs.push(d)
        }
      }
    } catch (e) {
      // If something goes wrong, simply don't include any user files.
    }

    return dictLangs
  }

  /**
    * Sets a configuration option
    * @param {String} option The option to be set
    * @param {Mixed} value  The value of the config variable.
    * @return {Boolean} Whether or not the option was successfully set.
    */
  set (option, value) {
    // Don't add non-existent options
    if (this.config.hasOwnProperty(option) && this._validate(option, value)) {
      this.config[option] = value
      this.emit('update') // Emit an event to all listeners
      return true
    }

    if (option.indexOf('.') > 0) {
      // A nested argument was requested, so iterate until we find it
      let nested = option.split('.')
      let prop = nested.pop() // Last one must be set manually, b/c simple attributes aren't pointers
      let cfg = this.config
      for (let arg of nested) {
        if (cfg.hasOwnProperty(arg)) {
          cfg = cfg[arg]
        } else {
          return false // The config option must match exactly
        }
      }

      // Set the nested property
      if (cfg.hasOwnProperty(prop) && this._validate(option, value)) {
        cfg[prop] = value
        this.emit('update') // Emit an event to all listeners
        return true
      }
    }

    return false
  }

  /**
   * This function allows multiple options to be set at once. It needs to be an
   * associative array in the form key:value.
   * @param  {Object} cfgObj An object containing the keys and new values.
   * @return {Boolean}        True, if all went well, or false, if an error occurred.
   */
  bulkSet (cfgObj) {
    // Iterate and return whether there was a mistake.
    let ret = true
    for (let opt in cfgObj) {
      if (!this.set(opt, cfgObj[opt])) ret = false
    }

    return ret
  }

  /**
    * Update the complete configuration object with new values
    * @param  {Object} newcfg               The new object containing new props
    * @param  {Object} [oldcfg=this.config] Necessary for recursion
    * @return {void}                      Does not return anything.
    */
  update (newcfg, oldcfg = this.config) {
    // Overwrite all given attributes (and leave the not given in place)
    // This will ensure sane defaults.
    for (var prop in oldcfg) {
      if (newcfg.hasOwnProperty(prop)) {
        // We have some variable-length arrays that only contain
        // strings, e.g. we cannot update them using update()
        if ((typeof oldcfg[prop] === 'object') && !Array.isArray(oldcfg[prop]) && oldcfg[prop] !== null) {
          // Update sub-object
          this.update(newcfg[prop], oldcfg[prop])
        } else {
          oldcfg[prop] = newcfg[prop]
        }
      }
    }

    this.emit('update') // Emit an event to all listeners
  }

  /**
    * Sorts the paths prior to using them alphabetically and by type.
    * @return {ZettlrConfig} Chainability.
    */
  _sortPaths () {
    let f = []
    let d = []
    for (let p of this.config['openPaths']) {
      if (isDir(p)) {
        d.push(p)
      } else {
        f.push(p)
      }
    }
    f.sort()
    d.sort()
    this.config['openPaths'] = f.concat(d)

    return this
  }

  /**
   * Validates a key's value based upon previously set up validation rules
   * @param  {string} key   The key (can be dotted) to be validated
   * @param  {mixed} value The value to be validated
   * @return {Boolean}       False, if a given validation failed, otherwise true.
   */
  _validate (key, value) {
    let rule = this._rules.find(elem => elem.getKey() === key)
    if (rule) { // There is a rule for this key, so validate
      return rule.validate(value)
    }
    return true // There are some options for which there is no validation.
  }
}

module.exports = ZettlrConfig
