<script setup lang="ts">
import { Archive, ArchiveRestore, AtSign, Ban, Bell, BellOff, Check, Copy, MessageSquare, Pin, PinOff, UserMinus, UserPlus, LogOut, Pencil } from 'lucide-vue-next'
import { computed } from 'vue'
import { toast } from 'vue-sonner'
import {
  ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuSub, ContextMenuSubContent, ContextMenuSubTrigger, ContextMenuTrigger,
} from '@/components/ui/context-menu'
import { chat } from '@/lib/chat'
import type { ConvId } from '@/lib/types'
import { errMsg } from '@/lib/format'
import { addMembersGroup, openConversation, pendingAction, renameGroupId } from '@/lib/nav'
import { MUTE_OPTIONS, copyText, muteFor, setPrefs } from '@/lib/ui'

/** Right-click menu for a friend (kind "dm", id = user ID) or a group (kind "group", id = group ID). */
const props = defineProps<{ kind: 'dm' | 'group'; id: string; openLabel?: string }>()

const convId = computed<ConvId>(() => (props.kind === 'dm' ? `dm:${props.id}` : `g:${props.id}`))
const conv = computed(() => chat.state.conversations.find((c) => c.id === convId.value))
const canAdmin = computed(() => props.kind === 'group' && chat.isGroupAdmin(props.id))

const prefs = (p: { pinned?: boolean; archived?: boolean; muted?: boolean; mentionsOnly?: boolean }) => setPrefs(convId.value, p)

async function open() {
  try {
    await openConversation(props.kind === 'dm' ? `dm:${props.id}` : `g:${props.id}`)
  } catch (e) {
    toast.error(errMsg(e))
  }
}
</script>

<template>
  <ContextMenu>
    <ContextMenuTrigger as-child class="select-none"><slot /></ContextMenuTrigger>
    <ContextMenuContent class="w-52">
      <ContextMenuItem @select="open"><MessageSquare />{{ openLabel ?? 'Open' }}</ContextMenuItem>
      <template v-if="conv">
        <ContextMenuItem @select="prefs({ pinned: !conv.pinned })"><PinOff v-if="conv.pinned" /><Pin v-else />{{ conv.pinned ? 'Unpin' : 'Pin' }}</ContextMenuItem>
        <ContextMenuItem v-if="conv.muted" @select="prefs({ muted: false })"><Bell />Unmute</ContextMenuItem>
        <ContextMenuSub v-else>
          <ContextMenuSubTrigger><BellOff />Mute</ContextMenuSubTrigger>
          <ContextMenuSubContent class="w-56">
            <ContextMenuItem v-for="o in MUTE_OPTIONS" :key="o.ms" @select="muteFor(convId, o.ms)">{{ o.label }}</ContextMenuItem>
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuItem v-if="kind === 'group'" @select="prefs({ mentionsOnly: !conv.mentionsOnly })"><AtSign />Only notify for mentions<Check v-if="conv.mentionsOnly" class="ml-auto" /></ContextMenuItem>
        <ContextMenuItem @select="prefs({ archived: !conv.archived })"><ArchiveRestore v-if="conv.archived" /><Archive v-else />{{ conv.archived ? 'Unarchive' : 'Archive' }}</ContextMenuItem>
        <ContextMenuSeparator />
      </template>
      <template v-if="kind === 'dm'">
        <ContextMenuItem @select="copyText(chat.formatId(id), 'ID copied')"><Copy />Copy ID</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem variant="destructive" @select="pendingAction = { kind: 'remove', id }"><UserMinus />Remove friend</ContextMenuItem>
        <ContextMenuItem variant="destructive" @select="pendingAction = { kind: 'block', id }"><Ban />Block</ContextMenuItem>
      </template>
      <template v-else>
        <ContextMenuItem @select="addMembersGroup = id"><UserPlus />Add members</ContextMenuItem>
        <ContextMenuItem v-if="canAdmin" @select="renameGroupId = id"><Pencil />Rename group</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem variant="destructive" @select="pendingAction = { kind: 'leave', id }"><LogOut />Leave group</ContextMenuItem>
      </template>
    </ContextMenuContent>
  </ContextMenu>
</template>
