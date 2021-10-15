/*!
 * Copyright 2021 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as settings from './parameterDescriptions.json'
import * as mde from '../../../types/clientmde'
import { isValidResponse, Wizard } from '../../shared/wizards/wizard'
import {
    createQuickPick,
    DataQuickPickItem,
    isDataQuickPickItem,
    QuickPickPrompter,
} from '../../shared/ui/pickerPrompter'
import { capitalize } from '../../shared/utilities/textUtilities'
import { createInputBox } from '../../shared/ui/inputPrompter'
import { Prompter } from '../../shared/ui/prompter'

export type InstanceType = keyof typeof environmentOptions['instanceType']

interface InstanceDescription {
    name: string
    specs: string
}

const environmentOptions = settings['environment']

function entries<T, K extends keyof T = keyof T & string>(obj: T): [K, T[K]][] {
    return Object.entries(obj) as any
}

function abbreviateUnit(unit: string): string {
    switch (unit) {
        case 'gigabyte':
            return 'GB'
        case 'megabyte':
            return 'MB'
        default:
            return ''
    }
}

export function getInstanceDescription(type: InstanceType): InstanceDescription {
    // TODO: add developer types?
    const desc = environmentOptions.instanceType[type]

    return {
        name: capitalize(type.slice(4)),
        specs: `${desc.vcpus} vCPUs, ${desc.ram.value}${abbreviateUnit(desc.ram.unit)} RAM`,
    }
}

function createInstancePrompt(): QuickPickPrompter<InstanceType> {
    const items = entries(environmentOptions.instanceType)
        .filter(([name]) => !name.startsWith('dev'))
        .map(([name, desc]) => ({
            data: name,
            label: `${getInstanceDescription(name).name} (${getInstanceDescription(name).specs})`,
        }))

    return createQuickPick(items, {
        title: 'Compute Size',
    })
}

function createTimeoutPrompt(): Prompter<number> {
    return createInputBox({
        title: 'Timeout Length',
        placeholder: 'Timeout length in minutes',
    }).transform(r => Number(r))
}

function createStoragePrompt(): QuickPickPrompter<typeof environmentOptions['persistentStorageSize'][number]> {
    const items = environmentOptions.persistentStorageSize.map(v => ({
        label: `${v} GB`,
        data: v,
    }))

    return createQuickPick(items, {
        title: 'Persistent Storage Size',
    })
}

// TODO: replace with JSON patch when DSC is merged
function diff<T>(obj1: T, obj2: T): Partial<T> {
    const d = {} as T
    entries(obj1)
        .concat(entries(obj2))
        .filter(([k, v]) =>
            typeof v !== 'object' ? obj1[k] !== obj2[k] : Object.keys(diff(obj1[k], obj2[k])).length > 0
        )
        .forEach(([k, v]) => (d[k] = typeof v === 'object' ? (diff(obj1[k], obj2[k]) as any) : v))
    return d
}

function createMenuPrompt(initState: SettingsForm, currentState: SettingsForm) {
    const diffState = diff(initState, currentState)

    const instanceDesc = getInstanceDescription(currentState.instanceType)
    const instanceItem = {
        label: 'Edit compute size',
        skipEstimate: true,
        description: diffState.instanceType !== undefined ? '(Modified)' : undefined,
        detail: `${instanceDesc.name} (${instanceDesc.specs})`,
        data: async () => {
            const prompter = createInstancePrompt()
            prompter.recentItem = currentState.instanceType
            const result = await prompter.prompt()

            if (isValidResponse(result)) {
                currentState.instanceType = result
            }

            return instanceItem
        },
    }

    const timeoutItem = {
        label: 'Edit timeout length',
        skipEstimate: true,
        description: diffState.inactivityTimeoutMinutes !== undefined ? '(Modified)' : undefined,
        detail: `${currentState.inactivityTimeoutMinutes} minutes`,
        data: async () => {
            const prompter = createTimeoutPrompt()
            prompter.recentItem = currentState.inactivityTimeoutMinutes
            const result = await prompter.prompt()

            if (isValidResponse(result)) {
                currentState.inactivityTimeoutMinutes = result
            }

            return timeoutItem
        },
    }

    const storageItem = {
        label: 'Edit persistent storage size',
        skipEstimate: true,
        description: diffState.persistentStorage?.sizeInGiB !== undefined ? '(Modified)' : undefined,
        detail: `${currentState.persistentStorage.sizeInGiB} GB`,
        data: async () => {
            const prompter = createStoragePrompt()
            prompter.recentItem = currentState.persistentStorage.sizeInGiB
            const result = await prompter.prompt()

            if (isValidResponse(result)) {
                currentState.persistentStorage = { sizeInGiB: result }
            }

            return storageItem
        },
    }

    const items = [instanceItem, timeoutItem, storageItem]

    const saveItem = {
        label: 'Save Settings',
        data: currentState,
        alwaysShow: true,
    }

    return createQuickPick<SettingsForm | DataQuickPickItem<any>>([saveItem, ...items], {
        title: 'Environment Settings',
    })
}

export type SettingsForm = Pick<
    mde.CreateEnvironmentRequest,
    'inactivityTimeoutMinutes' | 'instanceType' | 'persistentStorage'
> & {
    instanceType: InstanceType
}

// TODO: don't extend wizard, just make a separate class
// There's clearly an abstraction here, though not worth pursuing currently
export class EnvironmentSettingsWizard extends Wizard<SettingsForm> {
    constructor(private readonly initState: SettingsForm) {
        super()
    }

    public async run(): Promise<SettingsForm | undefined> {
        const curr = Object.assign({}, this.initState)
        let lastItem: DataQuickPickItem<any> | undefined

        while (true) {
            const prompter = createMenuPrompt(this.initState, curr)
            prompter.recentItem = lastItem
            const response = await prompter.prompt()

            if (!isValidResponse(response)) {
                break
            }

            if (isDataQuickPickItem(response)) {
                lastItem = response
                continue
            }

            return response
        }
    }
}
