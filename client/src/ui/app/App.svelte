<script lang="ts">
  import {
    screen,
    menu,
    settingsModal,
    inputPrompt,
    replayLib,
    replayViewer,
    exportModal,
  } from "./stores";
  import Menu from "../screens/Menu.svelte";
  import Connecting from "../screens/Connecting.svelte";
  import Hud from "../screens/Hud.svelte";
  import ReplayLibrary from "../screens/ReplayLibrary.svelte";
  import ReplayViewerBar from "../screens/ReplayViewerBar.svelte";
  import Settings from "../modals/Settings.svelte";
  import InputModePrompt from "../modals/InputModePrompt.svelte";
  import ExportModal from "../screens/ExportModal.svelte";
</script>

{#if $screen === "menu" && $menu}
  <Menu data={$menu} />
{:else if $screen === "connecting"}
  <Connecting />
{:else if $screen === "hud"}
  <Hud />
{:else if $screen === "replayLib" && $replayLib}
  <ReplayLibrary data={$replayLib} />
{:else if $screen === "replayViewer" && $replayViewer}
  <ReplayViewerBar data={$replayViewer} />
{/if}

<!-- Modals overlay whatever screen is showing. -->
{#if $inputPrompt}<InputModePrompt data={$inputPrompt} />{/if}
{#if $settingsModal}<Settings data={$settingsModal} />{/if}
{#if $exportModal}<ExportModal data={$exportModal} />{/if}
