# phone-organizer

Organize the files on an Android phone from Termux. One file, no dependencies.

**It never deletes anything.** It only moves files, never overwrites, shows a preview first, and keeps a log so `undo` puts everything back.

## Install (in Termux)

```
pkg update -y && pkg install -y nodejs curl
termux-setup-storage
curl -fsSL https://raw.githubusercontent.com/mohamedelsayed16399-bit/phone-organizer/main/organize.js -o organize.js
```

Tap ALLOW on the storage permission popup. Install Termux from F-Droid or GitHub releases, not the Play Store.

## Use

```
node organize.js            # preview for the Download folder, then asks before moving
node organize.js undo       # put back everything from the last run
node organize.js dupes      # find exact duplicate files (report only)
node organize.js dupes --move-dupes   # gather extra copies in Duplicates-Review/ for you to check
node organize.js big        # list the biggest files
```

Options: `--folder NAME` (e.g. `Documents`, can repeat), `--deep` (sub-folders too), `--flat` (no Year-Month level), `--list`, `--yes`, `--min-age MIN`.

Files go to `<folder>/Organized/<Type>/<YYYY-MM>/`. The date comes from the file name (IMG_20240315...) or the modified time.

## What it leaves alone

Hidden files, unfinished downloads (.crdownload, .part, .tmp), files changed in the last 10 minutes, the `Android` folder, symlinks, and anything already inside `Organized`. Default folder is `Download` only; photos in DCIM and app folders like WhatsApp are not touched unless you pass `--folder`.

## Test

`node test.js` runs the tests on a fake phone folder.
