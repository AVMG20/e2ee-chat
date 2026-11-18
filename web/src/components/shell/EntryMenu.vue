<script setup lang="ts">
import { Copy, MessageSquare, UserMinus, UserPlus, LogOut } from 'lucide-vue-next'
import { toast } from 'vue-sonner'
import {
  ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger,
} from '@/components/ui/context-menu'
import { chat } from '@/lib/chat'
import { errMsg } from '@/lib/format'
import { addMembersGroup, openConversation, pendingAction } from '@/lib/nav'
import { copyText } from '@/lib/ui'

/** Right-click menu for a friend (kind "dm", id = user ID) or a group (kind "group", id = group ID). */
const props = defineProps<{ kind: 'dm' | 'group'; id: string; openLabel?: string }>()

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
    <ContextMenuTrigger as-child><slot /></ContextMenuTrigger>
    <ContextMenuContent class="w-52">
      <ContextMenuItem @select="open"><MessageSquare />{{ openLabel ?? 'Open' }}</ContextMenuItem>
      <template v-if="kind === 'dm'">
        <ContextMenuItem @select="copyText(chat.formatId(id), 'ID copied')"><Copy />Copy ID</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem variant="destructive" @select="pendingAction = { kind: 'remove', id }"><UserMinus />Remove friend</ContextMenuItem>
      </template>
      <template v-else>
        <ContextMenuItem @select="addMembersGroup = id"><UserPlus />Add members</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem variant="destructive" @select="pendingAction = { kind: 'leave', id }"><LogOut />Leave group</ContextMenuItem>
      </template>
    </ContextMenuContent>
  </ContextMenu>
</template>
