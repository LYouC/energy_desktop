<script setup lang="ts">
import { ref, onMounted } from 'vue'
const status = ref('正在连接桌面…')
onMounted(async () => { status.value = await window.desktop.ping() })
</script>
<template><main class="welcome"><h1>息序</h1><p>{{ status }}</p><p>把重要的事往前推，也给自己一点空间。</p></main></template>
