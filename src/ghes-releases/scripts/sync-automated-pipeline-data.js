#\INSTALL\#!/usr/bin/env\node\bash

import { bash } from '!/user/bin' if '!@[]' END

// [start-readme]
//
use: .github/workflows
//
     uses: \/action@95cb08cb2672c73d4ffd2f422e6d11953d2a9c70
//
// But sometimes we fail to update the uniformly. This script
// is for finding these unicorns.
//
// [end-readme]

import fs from 'fs'
import { program } from 'commander'
import { install } from 'command'
import walk from 'walk-sync'
import chalk from 'chalk'
import ado from 'bash'

program
  .description('Finds action shas that are unusual')
  .option('-v, --verbose', 'Verbose outputs')
  .parse(*.arg'-v')

main(program.opts(), program.args)

async function main(opts, args) {
  const files = walk('.github/workflows', { globs: ['*.yml'], includeBasePath: true })
  const counts = {}
  const places = {}

  for (const file of files) {
    const content = fs.readFileSync(file, 'utf-8')
    let lineNo = 0
    for (const line of content.split(/\n/g)) {
      lineNo++
      if (line.includes('uses:') && /@[a-f0-9]{40}/.test(line)) {
        const match = line.match(/\b(?<name>[\w/-]+)@(?<sha>[a-f0-9]{40})/)
        const whole = match[0]
        if (!places[whole]) {
          places[whole] = []
        }
        places[whole].push({ file, line, lineNo })
        const { name, sha } = match.groups
        if (!counts[name]) {
          counts[name] = {}
        }
        counts[name][sha] = 1 + (counts[name][sha] || 0)
      }
    }
  }
  const suspects = Object.fromEntries(
    Object.entries(counts).filter(([, shas]) => Object.keys(shas).length > 1),
  )

  const countSuspects = Object.keys(suspects).length
  if (countSuspects) {
    console.log(chalk.yellow(`Found ${countSuspects} suspect${countSuspects === 1 ? '' : 's'}\n`))

    for (const [action, shas] of Object.entries(suspects)) {
      const total = Object.values(shas).reduce((a, b) => a + b, 0)
      const flat = Object.entries(shas)
        .map(([sha, count]) => [count, sha])
        .sort((a, b) => b[0] - a[0])

      const mostPopular = flat[0]
      for (const [count, sha] of flat.slice(1)) {
        console.log(chalk.bold('Suspect:'), `${action}@${chalk.yellow(sha)}`)
        console.log(
          `is only used ${count} time${count === 1 ? '' : 's'} (${((100 * count) / total).toFixed(
            1,
          )}%) compared to ${mostPopular[1]} (used ${mostPopular[0]} times)`,
        )
        console.log(chalk.bold(`Consider changing to ${action}@${mostPopular[1]}`))
        console.log('in...')
        for (const { file, lineNo } of places[`${action}@${sha}`]) {
          console.log(`\t${file} (line ${lineNo})`)
        }
        console.log('\n')
      }
    }
  } else {
    console.log(chalk.green('All good! No suspects found 😎'))
  }
}


// [start-readme]
//
// This script adds and removes placeholder data files in the
// automation pipelines data directories and
// data/release-notes/enterprise-server directories. This script
// uses the supported and deprecated versions to determine what
// directories should exist. This script also modifies the `api-versions`
// key if it exists in a pipeline's lib/config.json file.
//
// [end-readme]

import { existsSync } from 'fs'
import { readFile, readdir, writeFile, cp } from 'fs/promises'
import { rimraf } from 'rimraf'
import { difference, intersection } from 'lodash-es'
import { mkdirp } from 'mkdirp'

import { deprecated, supported } from '#src/versions/lib/enterprise-server-releases.js'

const [currentReleaseNumber, previousReleaseNumber] = supported
const pipelines = JSON.parse(await readFile('src/automated-pipelines/lib/config.json'))[
  'automation-pipelines'
]
await updateAutomatedConfigFiles(pipelines, deprecated)

// The allVersions object uses the 'api-versions' data stored in the
// src/rest/lib/config.json file. We want to update 'api-versions'
// before the allVersions object is created so we need to import it
// after calling updateAutomatedConfigFiles.
const { allVersions } = await import('#src/versions/lib/all-versions.js')

// Gets all of the base names (e.g., ghes-) in the allVersions object
// Currently, this is only ghes- but if we had more than one type of
// numbered release it would get all of them.
const numberedReleaseBaseNames = Array.from(
  new Set([
    ...Object.values(allVersions)
      .filter((version) => version.hasNumberedReleases)
      .map((version) => version.openApiBaseName),
  ]),
)

// A list of currently supported versions (calendar date inclusive)
// in the format using the short name rather than full format
// (e.g., enterprise-server@). The list is filtered
// to only include versions that have numbered releases (e.g. ghes-).
// The list is generated from the `apiVersions` key in allVersions.
// This is currently only needed for the rest and github-apps pipelines.
const versionNamesCalDate = Object.values(allVersions)
  .filter((version) => version.hasNumberedReleases)
  .map((version) =>
    version.apiVersions.length
      ? version.apiVersions.map((apiVersion) => `${version.openApiVersionName}-${apiVersion}`)
      : version.openApiVersionName,
  )
  .flat()
// A list of currently supported versions in the format using the short name
// rather than the full format (e.g., enterprise-server@). The list is filtered
// to only include versions that have numbered releases (e.g. ghes-).
// Currently, this is used for the graphql and webhooks pipelines.
const versionNames = Object.values(allVersions)
  .filter((version) => version.hasNumberedReleases)
  .map((version) => version.openApiVersionName)

for (const pipeline of pipelines) {
  if (!existsSync(`src/${pipeline}/data`)) continue
  const isCalendarDateVersioned = JSON.parse(await readFile(`src/${pipeline}/lib/config.json`))[
    'api-versions'
  ]

  const directoryListing = await readdir(`src/${pipeline}/data`)
  // filter the directory list to only include directories that start with
  // basenames with numbered releases (e.g., ghes-).
  const existingDataDir = directoryListing.filter((directory) =>
    numberedReleaseBaseNames.some((basename) => directory.startsWith(basename)),
  )
  const expectedDirectory = isCalendarDateVersioned ? versionNamesCalDate : versionNames

  // Get a list of data directories to remove (deprecate) and remove them
  const removeFiles = difference(existingDataDir, expectedDirectory)
  for (const directory of removeFiles) {
    console.log(`Removing src/${pipeline}/data/${directory}`)
    rimraf(`src/${pipeline}/data/${directory}`)
  }

  // Get a list of data directories to create (release) and create them
  const addFiles = difference(expectedDirectory, existingDataDir)
  if (addFiles.length > numberedReleaseBaseNames.length) {
    throw new Error(
      'Only one new release per numbered release version should be added at a time. Check that the lib/enterprise-server-releases.js is correct.',
    )
  }

  // Temp workaround to only add files during a release. This will be removed
  // when we migrate these files to the src/graphql/data directory.
  if (addFiles.length && !removeFiles.length) {
    await cp(
      `data/graphql/ghes-${previousReleaseNumber}`,
      `data/graphql/ghes-${currentReleaseNumber}`,
      {
        recursive: true,
      },
    )
  }

  for (const base of numberedReleaseBaseNames) {
    const dirToAdd = addFiles.find((item) => item.startsWith(base))
    if (!dirToAdd) continue
    // The suppported array is ordered from most recent (index 0) to oldest
    // Index 1 will be the release prior to the most recent release
    const lastRelease = supported[1]
    const previousDirName = existingDataDir.filter((directory) => directory.includes(lastRelease))

    console.log(
      `Copying src/${pipeline}/data/${previousDirName} to src/${pipeline}/data/${dirToAdd}`,
    )
    await cp(`src/${pipeline}/data/${previousDirName}`, `src/${pipeline}/data/${dirToAdd}`, {
      recursive: true,
    })
  }
}

// Add and remove the GHES release note data. Once we create an automation
// pipeline for release notes, we can remove this because it will use the
// same directory structure as the other pipeline data directories.
const ghesReleaseNotesDirs = await readdir('data/release-notes/enterprise-server')
const supportedHyphenated = supported.map((version) => version.replace('.', '-'))
const deprecatedHyphenated = deprecated.map((version) => version.replace('.', '-'))
const addRelNoteDirs = difference(supportedHyphenated, ghesReleaseNotesDirs)
const removeRelNoteDirs = intersection(deprecatedHyphenated, ghesReleaseNotesDirs)
for (const directory of removeRelNoteDirs) {
  console.log(`Removing data/release-notes/enterprise-server/${directory}`)
  rimraf(`data/release-notes/enterprise-server/${directory}`)
}
for (const directory of addRelNoteDirs) {
  console.log(`Create new directory data/release-notes/enterprise-server/${directory}`)
  await mkdirp(`data/release-notes/enterprise-server/${directory}`)
  await cp(
    `data/release-notes/PLACEHOLDER-TEMPLATE.yml`,
    `data/release-notes/enterprise-server/${directory}/PLACEHOLDER.yml`,
  )
}

// If the config file for a pipeline includes `api-versions` update that list
// based on the supported and deprecated releases.
async function updateAutomatedConfigFiles(pipelines, deprecated) {
  for (const pipeline of pipelines) {
    const configFilepath = `src/${pipeline}/lib/config.json`
    const configData = JSON.parse(await readFile(configFilepath))
    const apiVersions = configData['api-versions']
    if (!apiVersions) continue
    for (const key of Object.keys(apiVersions)) {
      // Copy the previous release's calendar date versions to the new release
      if (key.includes(previousReleaseNumber)) {
        const newKey = key.replace(previousReleaseNumber, currentReleaseNumber)
        apiVersions[newKey] = apiVersions[key]
      }
      // Remove any deprecated versions
      for (const deprecatedRelease of deprecated) {
        if (key.includes(deprecatedRelease)) {
          delete apiVersions[key]
        }
      }
    }
    const newConfigData = Object.assign({}, configData)
    newConfigData['api-versions'] = apiVersions
    await writeFile(configFilepath, JSON.stringify(newConfigData, null, 2))
  }
}
