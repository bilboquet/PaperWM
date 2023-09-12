const ExtensionUtils = imports.misc.extensionUtils;
const { Gio, GLib } = imports.gi;

/**
    Settings utility shared between the running extension and the preference UI.
    settings.js shouldn't depend on other modules (e.g with `imports` for other modules
    at the top).
 */

let KEYBINDINGS_KEY = 'org.gnome.shell.extensions.paperwm.keybindings';
let RESTORE_KEYBINDS_KEY = 'restore-keybinds';

function setState($, key) {
    let value = gsettings.get_value(key);
    let name = key.replace(/-/g, '_');
    prefs[name] = value.deep_unpack();
}

var conflictSettings; // exported
function getConflictSettings() {
    if (!conflictSettings) {
        // Schemas that may contain conflicting keybindings
        // It's possible to inject or remove settings here on `user.init`.
        conflictSettings = [
            new Gio.Settings({ schema_id: 'org.gnome.mutter.keybindings' }),
            new Gio.Settings({ schema_id: 'org.gnome.mutter.wayland.keybindings' }),
            new Gio.Settings({ schema_id: "org.gnome.desktop.wm.keybindings" }),
            new Gio.Settings({ schema_id: "org.gnome.shell.keybindings" }),
        ];
    }

    return conflictSettings;
}

var prefs;
let gsettings, _overriddingConflicts;
function enable() {
    gsettings = ExtensionUtils.getSettings();
    _overriddingConflicts = false;
    prefs = {};
    ['window-gap', 'vertical-margin', 'vertical-margin-bottom', 'horizontal-margin',
        'workspace-colors', 'default-background', 'animation-time', 'use-workspace-name',
        'pressure-barrier', 'default-show-top-bar', 'swipe-sensitivity', 'swipe-friction',
        'cycle-width-steps', 'cycle-height-steps', 'minimap-scale', 'winprops',
        'show-workspace-indicator', 'show-window-position-bar', 'show-focus-mode-icon',
        'disable-topbar-styling', 'default-focus-mode', 'gesture-enabled',
        'gesture-horizontal-fingers', 'gesture-workspace-fingers']
        .forEach(k => setState(null, k));
    prefs.__defineGetter__("minimum_margin", function () {
        return Math.min(15, this.horizontal_margin);
    });
    gsettings.connect('changed', setState);

    // connect to settings and update winprops array when it's updated
    gsettings.connect('changed::winprops', () => reloadWinpropsFromGSettings());

    // A intermediate window is created before the prefs dialog is created.
    // Prevent it from being inserted into the tiling causing flickering and general disorder
    defwinprop({
        wm_class: "Gnome-shell-extension-prefs",
        scratch_layer: true,
        focus: true,
    });
    defwinprop({
        wm_class: /gnome-screenshot/i,
        scratch_layer: true,
        focus: true,
    });

    addWinpropsFromGSettings();
}

function disable() {
    gsettings = null;
    _overriddingConflicts = null;
    prefs = null;
    conflictSettings = null;
}

// / Keybindings

/**
 * Returns the GDK mask value for a keystr (keybind string representation).
 * Refer to:
 * https://gitlab.gnome.org/GNOME/gtk/-/blob/4.13.0/gdk/gdkenums.h?ref_type=tags#L115
 * https://gitlab.gnome.org/GNOME/gtk/-/blob/4.13.0/gtk/gtkaccelgroup.c#L571
 * @param {String} keystr
 */
// GDK keystr mask values.
let GDK_SHIFT_MASK    = 1 << 0;
let GDK_CONTROL_MASK  = 1 << 2;
let GDK_ALT_MASK      = 1 << 3;
let GDK_SUPER_MASK    = 1 << 26;
let GDK_HYPER_MASK    = 1 << 27;
let GDK_META_MASK     = 1 << 28;
function accelerator_mask(keystr) {
    // need to extact all mods from keystr
    const mods = accelerator_mods(keystr);
    let result = 0;
    for (let mod of mods) {
        switch (mod.toLowerCase()) {
        case '<shift>':
            result |= GDK_SHIFT_MASK;
            break;
        case '<control>':
        case '<ctrl>':
        case '<primary>':
            result |= GDK_CONTROL_MASK;
            break;
        case '<alt>':
            result |= GDK_ALT_MASK;
            break;
        case '<super>':
            result |= GDK_SUPER_MASK;
            break;
        case '<hyper>':
            result |= GDK_HYPER_MASK;
            break;
        case '<meta>':
            result |= GDK_META_MASK;
        }
    }

    return result;
}

/**
 * Returns array of mods for a keystr, e.g. ['<Control>', '<Shift>', '<Alt>'].
 * @param {String} keystr
 */
function accelerator_mods(keystr) {
    return keystr.match(/<.*?>/g) ?? [];
}

/**
 * Two keystrings can represent the same key combination.
 * Attempt to normalise keystr by sections.
 */
function keystrToKeycombo(keystr) {
    // use 'grave' instead of 'Above_Tab' (just normalising on one)
    if (keystr.match(/Above_Tab/)) {
        keystr = keystr.replace('Above_Tab', 'grave');
    }

    // get mask for this keystr
    const mask = accelerator_mask(keystr);
    const mods = accelerator_mods(keystr);

    // remove mods from keystr
    let result = keystr;
    mods.forEach(m => {
        result = result.replace(m, '');
    });
    result = result.trim().toLowerCase();

    // combine mask with remaining key
    // console.log(`${keystr} : ${mask}|${result}`);
    return `${mask}|${result}`;
}

function generateKeycomboMap(settings) {
    let map = {};
    for (let name of settings.list_keys()) {
        let value = settings.get_value(name);
        if (value.get_type_string() !== 'as')
            continue;

        for (let combo of value.deep_unpack().map(keystrToKeycombo)) {
            if (map[combo]) {
                map[combo].push(name);
            } else {
                map[combo] = [name];
            }
        }
    }
    return map;
}

function findConflicts(schemas) {
    schemas = schemas || getConflictSettings();
    let conflicts = [];
    const paperMap = generateKeycomboMap(ExtensionUtils.getSettings(KEYBINDINGS_KEY));

    for (let settings of schemas) {
        const against = generateKeycomboMap(settings);
        for (let combo in paperMap) {
            if (against[combo]) {
                conflicts.push({
                    name: paperMap[combo][0],
                    conflicts: against[combo],
                    settings, combo,
                });
            }
        }
    }
    return conflicts;
}

/**
 * Returns / reconstitutes saved overrides list.
 */
function getSavedOverrides() {
    let saveListJson = gsettings.get_string(RESTORE_KEYBINDS_KEY);
    let saveList;
    try {
        saveList = new Map(Object.entries(JSON.parse(saveListJson)));
    } catch (error) {
        saveList = new Map();
    }
    return saveList;
}

/**
 * Saves an overrides list.
 */
function saveOverrides(overrides) {
    gsettings.set_string(RESTORE_KEYBINDS_KEY, JSON.stringify(Object.fromEntries(overrides)));
}

function conflictKeyChanged(settings, key) {
    if (_overriddingConflicts) {
        return;
    }

    const newKeybind = settings.get_value(key).deep_unpack();
    if (Array.isArray(newKeybind) && newKeybind.length === 0) {
        return;
    }

    const saveList = getSavedOverrides();
    saveList.delete(key);
    saveOverrides(saveList);

    // check for new conflicts
    return overrideConflicts(key);
}

/**
 * Override conflicts and save original values for restore.
 */
function overrideConflicts(checkKey = null) {
    if (_overriddingConflicts) {
        return;
    }

    _overriddingConflicts = true;
    let saveList = getSavedOverrides();

    // restore orignal keybinds prior to conflict overriding
    restoreConflicts();

    let disableAll = [];
    const foundConflicts = findConflicts();
    for (let conflict of foundConflicts) {
        // save conflicts (list of names of conflicting keybinds)
        let { name, conflicts, settings } = conflict;

        conflicts.forEach(c => {
            // get current value
            const keybind = settings.get_value(c);
            saveList.set(c, {
                bind: JSON.stringify(keybind.deep_unpack()),
                schema_id: settings.schema_id,
            });

            // now disable conflict
            disableAll.push(() => settings.set_value(c, new GLib.Variant('as', [])));
        });
    }

    // save override list
    saveOverrides(saveList);

    // now disable all conflicts
    disableAll.forEach(d => d());
    _overriddingConflicts = false;

    return checkKey ? saveList.has(checkKey) : false;
}

/**
 * Update overrides to their current keybinds.
 */
function updateOverrides() {
    let saveList = getSavedOverrides();
    saveList.forEach((saved, key) => {
        const settings = getConflictSettings().find(s => s.schema_id === saved.schema_id);
        if (settings) {
            const newKeybind = settings.get_value(key).deep_unpack();
            if (Array.isArray(newKeybind) && newKeybind.length === 0) {
                return;
            }

            saveList.set(key, {
                bind: JSON.stringify(newKeybind),
                schema_id: settings.schema_id,
            });
        }
    });

    // save override list
    saveOverrides(saveList);
}

/**
 * Restores previously overridden conflicts.
 */
function restoreConflicts() {
    let saveList = getSavedOverrides();
    const toRemove = [];
    saveList.forEach((saved, key) => {
        const settings = getConflictSettings().find(s => s.schema_id === saved.schema_id);
        if (settings) {
            const keybind = JSON.parse(saved.bind);
            toRemove.push({ key, remove: () => settings.set_value(key, new GLib.Variant('as', keybind)) });
        }
    });

    // now remove retored keybinds from list
    toRemove.forEach(r => {
        r.remove();
        saveList.delete(r.key);
    });
    saveOverrides(saveList);
}

// / Winprops

/**
   Modelled after notion/ion3's system

   Examples:

   defwinprop({
     wm_class: "Riot",
     scratch_layer: true
   })
*/
var winprops = [];

function winprop_match_p(meta_window, prop) {
    let wm_class = meta_window.wm_class || "";
    let title = meta_window.title;
    if (prop.wm_class) {
        if (prop.wm_class instanceof RegExp) {
            if (!wm_class.match(prop.wm_class))
                return false;
        } else if (prop.wm_class !== wm_class) {
            return false;
        }
    }
    if (prop.title) {
        if (prop.title instanceof RegExp) {
            if (!title.match(prop.title))
                return false;
        } else if (prop.title !== title)
            return false;
    }

    return true;
}

function find_winprop(meta_window)  {
    // sort by title first (prioritise title over wm_class)
    let props = winprops.filter(winprop_match_p.bind(null, meta_window));

    // if matching props found, return first one
    if (props.length > 0) {
        return props[0];
    }

    // fall back, if star (catch-all) winprop exists, return the first one
    let starProps = winprops.filter(w => w.wm_class === "*" || w.title === "*");
    if (starProps.length > 0) {
        return starProps[0];
    }

    return null;
}

function defwinprop(spec) {
    // process preferredWidth - expects inputs like 50% or 400px
    if (spec.preferredWidth) {
        spec.preferredWidth = {
            // value is first contiguous block of digits
            value: new Number((spec.preferredWidth.match(/\d+/) ?? ['0'])[0]),
            // unit is first contiguous block of apha chars or % char
            unit: (spec.preferredWidth.match(/[a-zA-Z%]+/) ?? ['NO_UNIT'])[0],
        };
    }

    /**
     * we order specs with gsettings rirst ==> gsetting winprops take precedence
     * over winprops defined in user.js.  This was done since gsetting winprops
     * are easier to add/remove (and can be added/removed/edited instantly without
     * restarting shell).
     */
    // add winprop
    winprops.push(spec);

    // now order winprops with gsettings first, then title over wm_class
    winprops.sort((a, b) => {
        let firstresult = 0;
        if (a.gsetting && !b.gsetting) {
            firstresult = -1;
        }
        else if (!a.gsetting && b.gsetting) {
            firstresult = 1;
        }

        // second compare, prioritise title
        let secondresult = 0;
        if (a.title && !b.title) {
            secondresult = -1;
        }
        else if (!a.title && b.title) {
            secondresult = 1;
        }

        return firstresult || secondresult;
    });
}

/**
 * Adds user-defined winprops from gsettings (as defined in
 * org.gnome.shell.extensions.paperwm.winprops) to the winprops array.
 */
function addWinpropsFromGSettings() {
    // add gsetting (user config) winprops
    gsettings.get_value('winprops').deep_unpack()
        .map(value => JSON.parse(value))
        .forEach(prop => {
            // test if wm_class or title is a regex expression
            if (/^\/.+\/[igmsuy]*$/.test(prop.wm_class)) {
                // extract inner regex and flags from wm_class
                let matches = prop.wm_class.match(/^\/(.+)\/([igmsuy]*)$/);
                let inner = matches[1];
                let flags = matches[2];
                prop.wm_class = new RegExp(inner, flags);
            }
            if (/^\/.+\/[igmsuy]*$/.test(prop.title)) {
                // extract inner regex and flags from title
                let matches = prop.title.match(/^\/(.+)\/([igmsuy]*)$/);
                let inner = matches[1];
                let flags = matches[2];
                prop.title = new RegExp(inner, flags);
            }
            prop.gsetting = true; // set property that is from user gsettings
            defwinprop(prop);
        });
}

/**
 * Removes winprops with the `gsetting:true` property from the winprops array.
 */
function removeGSettingWinpropsFromArray() {
    winprops = winprops.filter(prop => !prop.gsetting ?? true);
}

/**
 * Effectively reloads winprops from gsettings.
 * This is a convenience function which removes gsetting winprops from winprops
 * array and then adds the currently defined
 * org.gnome.shell.extensions.paperwm.winprops winprops.
 */
function reloadWinpropsFromGSettings() {
    removeGSettingWinpropsFromArray();
    addWinpropsFromGSettings();
}
