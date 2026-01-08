# Plugin UI Spec

## Purpose

Define the user interface components for PeerVault, including settings, peer management, and sync status.

## Requirements

- **REQ-UI-01**: MUST provide settings tab in Obsidian settings
- **REQ-UI-02**: MUST show sync status in status bar
- **REQ-UI-03**: MUST provide peer management interface
- **REQ-UI-04**: MUST support QR code display and scanning for pairing
- **REQ-UI-05**: MUST show document history/versions

## UI Components

### 1. Status Bar Item

Shows sync status at a glance.

```
States:
- ● Synced                    (green dot)
- ◐ Syncing...               (animated)
- ○ Offline                  (gray dot)
- ⚠ Sync error              (yellow warning)
```

```typescript
class SyncStatusBar {
  private statusBarItem: HTMLElement;

  constructor(private plugin: Plugin) {
    this.statusBarItem = plugin.addStatusBarItem();
    this.statusBarItem.addClass('peervault-status');
  }

  update(state: SyncState): void {
    this.statusBarItem.empty();

    const icon = this.statusBarItem.createSpan({ cls: 'status-icon' });
    const text = this.statusBarItem.createSpan({ cls: 'status-text' });

    switch (state.status) {
      case 'synced':
        icon.addClass('synced');
        text.setText(`Synced with ${state.peerCount} peer(s)`);
        break;
      case 'syncing':
        icon.addClass('syncing');
        text.setText('Syncing...');
        break;
      case 'offline':
        icon.addClass('offline');
        text.setText('Offline');
        break;
      case 'error':
        icon.addClass('error');
        text.setText('Sync error');
        break;
    }

    // Click to open peer panel
    this.statusBarItem.onClickEvent(() => {
      this.plugin.showPeerPanel();
    });
  }
}
```

### 2. Settings Tab

Plugin configuration in Obsidian Settings.

```typescript
class PeerVaultSettingTab extends PluginSettingTab {
  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl('h2', { text: 'PeerVault Settings' });

    // --- Identity Section ---
    containerEl.createEl('h3', { text: 'Identity' });

    new Setting(containerEl)
      .setName('Your Device ID')
      .setDesc('Share this with peers to let them connect to you')
      .addText(text => text
        .setValue(this.plugin.transport.getNodeId())
        .setDisabled(true)
      )
      .addButton(btn => btn
        .setIcon('copy')
        .onClick(() => navigator.clipboard.writeText(this.plugin.transport.getNodeId()))
      );

    // --- Peers Section ---
    containerEl.createEl('h3', { text: 'Connected Peers' });

    new Setting(containerEl)
      .setName('Add Device')
      .setDesc('Connect a new device to sync with')
      .addButton(btn => btn
        .setButtonText('Show QR Code')
        .onClick(() => this.showAddDeviceModal())
      )
      .addButton(btn => btn
        .setButtonText('Enter Ticket')
        .onClick(() => this.showJoinDeviceModal())
      );

    // List existing peers
    this.displayPeerList(containerEl);

    // --- Sync Section ---
    containerEl.createEl('h3', { text: 'Sync Options' });

    new Setting(containerEl)
      .setName('Auto-sync on startup')
      .setDesc('Automatically connect to peers when Obsidian opens')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.autoSync)
        .onChange(value => this.plugin.updateSettings({ autoSync: value }))
      );

    new Setting(containerEl)
      .setName('Excluded folders')
      .setDesc('Folders to exclude from sync (one per line)')
      .addTextArea(text => text
        .setValue(this.plugin.settings.excludedFolders.join('\n'))
        .onChange(value => {
          const folders = value.split('\n').filter(f => f.trim());
          this.plugin.updateSettings({ excludedFolders: folders });
        })
      );
  }

  private displayPeerList(containerEl: HTMLElement): void {
    const peers = this.plugin.peerManager.getPeerStates();

    if (peers.length === 0) {
      containerEl.createEl('p', {
        text: 'No peers connected. Add a device to start syncing.',
        cls: 'peervault-no-peers'
      });
      return;
    }

    for (const state of peers) {
      new Setting(containerEl)
        .setName(state.peer.name)
        .setDesc(this.getPeerStatusText(state))
        .addButton(btn => btn
          .setIcon(state.status === 'connected' ? 'unlink' : 'link')
          .setTooltip(state.status === 'connected' ? 'Disconnect' : 'Connect')
          .onClick(() => this.togglePeerConnection(state))
        )
        .addButton(btn => btn
          .setIcon('trash')
          .setTooltip('Remove peer')
          .onClick(() => this.removePeer(state.peer.nodeId))
        );
    }
  }
}
```

### 3. Add Device Modal (QR Code)

Display QR code for pairing.

```typescript
class AddDeviceModal extends Modal {
  private ticket: string = '';

  async onOpen(): Promise<void> {
    const { contentEl } = this;

    contentEl.createEl('h2', { text: 'Add Device' });
    contentEl.createEl('p', {
      text: 'Scan this QR code from another device running PeerVault'
    });

    // Generate ticket
    this.ticket = await this.plugin.transport.generateTicket();

    // QR Code container
    const qrContainer = contentEl.createDiv({ cls: 'peervault-qr' });

    // Use qrcode library to generate QR
    QRCode.toCanvas(qrContainer, this.ticket, {
      width: 256,
      margin: 2,
    });

    // Copy button
    new Setting(contentEl)
      .setName('Or copy ticket')
      .addButton(btn => btn
        .setButtonText('Copy')
        .onClick(() => {
          navigator.clipboard.writeText(this.ticket);
          new Notice('Ticket copied to clipboard');
        })
      );

    // Waiting indicator
    contentEl.createEl('p', {
      text: 'Waiting for connection...',
      cls: 'peervault-waiting'
    });

    // Listen for incoming connection
    this.plugin.transport.onIncomingConnection((conn) => {
      this.handleConnection(conn);
    });
  }

  private async handleConnection(conn: PeerConnection): Promise<void> {
    // Prompt for peer name
    const name = await this.promptPeerName();

    await this.plugin.peerManager.addPeer(this.ticket, name);

    new Notice(`Connected to ${name}`);
    this.close();
  }
}
```

### 4. Join Device Modal

Enter ticket to join another device.

```typescript
class JoinDeviceModal extends Modal {
  onOpen(): void {
    const { contentEl } = this;

    contentEl.createEl('h2', { text: 'Join Device' });
    contentEl.createEl('p', {
      text: 'Enter the ticket from another device'
    });

    let ticketInput: TextAreaComponent;
    let nameInput: TextComponent;

    new Setting(contentEl)
      .setName('Ticket')
      .addTextArea(text => {
        ticketInput = text;
        text.setPlaceholder('Paste ticket here...');
      });

    new Setting(contentEl)
      .setName('Device Name')
      .addText(text => {
        nameInput = text;
        text.setPlaceholder('e.g., MacBook Pro');
      });

    new Setting(contentEl)
      .addButton(btn => btn
        .setButtonText('Connect')
        .setCta()
        .onClick(() => this.connect(ticketInput.getValue(), nameInput.getValue()))
      );
  }

  private async connect(ticket: string, name: string): Promise<void> {
    if (!ticket || !name) {
      new Notice('Please enter both ticket and name');
      return;
    }

    try {
      await this.plugin.peerManager.addPeer(ticket, name);
      new Notice(`Connected to ${name}`);
      this.close();
    } catch (err) {
      new Notice(`Connection failed: ${err.message}`);
    }
  }
}
```

### 5. Document History View

Show version history for a file.

```typescript
class HistoryView extends ItemView {
  static VIEW_TYPE = 'peervault-history';

  private filePath: string | null = null;

  getViewType(): string {
    return HistoryView.VIEW_TYPE;
  }

  getDisplayText(): string {
    return 'Document History';
  }

  async showHistory(filePath: string): Promise<void> {
    this.filePath = filePath;
    const container = this.containerEl.children[1];
    container.empty();

    container.createEl('h3', { text: `History: ${filePath}` });

    // Get document and its history
    const doc = await this.plugin.docManager.getDoc(filePath);
    if (!doc) {
      container.createEl('p', { text: 'No sync history for this file' });
      return;
    }

    // Get all changes
    const history = Automerge.getHistory(doc);

    const list = container.createEl('ul', { cls: 'peervault-history-list' });

    for (const entry of history.reverse()) {
      const item = list.createEl('li');

      const time = new Date(entry.change.time).toLocaleString();
      const actor = entry.change.actor.substring(0, 8);

      item.createEl('span', { text: time, cls: 'history-time' });
      item.createEl('span', { text: ` by ${actor}`, cls: 'history-actor' });

      // Restore button
      const restoreBtn = item.createEl('button', { text: 'Restore' });
      restoreBtn.onclick = () => this.restoreVersion(entry);
    }
  }

  private async restoreVersion(entry: HistoryEntry): Promise<void> {
    // Restore would create a new change that sets content to old version
    // This preserves history while reverting content
  }
}
```

## Commands

Register Obsidian commands:

```typescript
plugin.addCommand({
  id: 'show-peer-panel',
  name: 'Show peer management',
  callback: () => this.showPeerPanel(),
});

plugin.addCommand({
  id: 'show-file-history',
  name: 'Show sync history for current file',
  editorCallback: (editor, view) => {
    this.showHistoryForFile(view.file?.path);
  },
});

plugin.addCommand({
  id: 'force-sync',
  name: 'Force sync now',
  callback: () => this.syncEngine.syncAll(),
});
```

## CSS Styles

```css
/* Status bar */
.peervault-status {
  cursor: pointer;
}

.peervault-status .status-icon {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  margin-right: 4px;
}

.peervault-status .status-icon.synced {
  background-color: var(--color-green);
}

.peervault-status .status-icon.syncing {
  background-color: var(--color-blue);
  animation: pulse 1s infinite;
}

.peervault-status .status-icon.offline {
  background-color: var(--color-base-50);
}

.peervault-status .status-icon.error {
  background-color: var(--color-yellow);
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}

/* QR Code modal */
.peervault-qr {
  display: flex;
  justify-content: center;
  margin: 20px 0;
}

/* History list */
.peervault-history-list {
  list-style: none;
  padding: 0;
}

.peervault-history-list li {
  padding: 8px;
  border-bottom: 1px solid var(--background-modifier-border);
}

.peervault-history-list .history-time {
  font-weight: bold;
}

.peervault-history-list .history-actor {
  color: var(--text-muted);
  font-size: 0.9em;
}
```

## Dependencies

- Obsidian Plugin API (Modal, Setting, ItemView, etc.)
- QR code library (e.g., `qrcode`)

## Open Questions

1. **Mobile UI**: Different layout for mobile Obsidian?
2. **QR scanning**: Can we access camera in Obsidian mobile?
3. **Notifications**: How verbose should sync notifications be?
