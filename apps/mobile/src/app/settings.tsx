import type { AiProviderId, Language, ThemeMode } from '@trailpack/shared';
import { useEffect } from 'react';
import { Platform, View } from 'react-native';

import { Card, Screen, SectionHeader, SegmentedControl, Select, Text, TextField } from '@/components/ui';
import { LANGUAGE_LABELS, setLanguage } from '@/i18n';
import { useAiKeyStore } from '@/stores/ai';
import { useSettingsStore } from '@/stores/settings';
import { useTheme } from '@/theme/ThemeProvider';

const PROVIDERS: Array<{ value: AiProviderId; label: string }> = [
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'openai', label: 'OpenAI' },
  { value: 'gemini', label: 'Google Gemini' },
  { value: 'openai_compatible', label: 'Lokální server (OpenAI kompatibilní)' },
];

export default function SettingsScreen() {
  const theme = useTheme();
  const settings = useSettingsStore((s) => s.settings);
  const update = useSettingsStore((s) => s.update);
  const apiKey = useAiKeyStore((s) => s.apiKey);
  const setApiKey = useAiKeyStore((s) => s.setApiKey);
  const hydrate = useAiKeyStore((s) => s.hydrate);

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  return (
    <Screen title="Nastavení" back>
      <Card>
        <SectionHeader title="Vzhled" />
        <SegmentedControl<ThemeMode>
          value={settings.theme}
          onChange={(v) => update({ theme: v })}
          options={[
            { value: 'system', label: 'Systém' },
            { value: 'light', label: 'Světlý' },
            { value: 'dark', label: 'Tmavý' },
            { value: 'outdoor', label: 'Outdoor' },
          ]}
        />
        <View style={{ height: theme.spacing.md }} />
        <Select<Language>
          label="Jazyk"
          value={settings.language}
          options={(Object.keys(LANGUAGE_LABELS) as Language[]).map((l) => ({ value: l, label: LANGUAGE_LABELS[l] }))}
          onChange={(l) => {
            update({ language: l });
            setLanguage(l);
          }}
        />
      </Card>
      <View style={{ height: theme.spacing.md }} />
      <Card>
        <SectionHeader title="AI asistent" />
        <View style={{ gap: theme.spacing.md }}>
          <Select<AiProviderId>
            label="Poskytovatel"
            value={settings.aiProvider}
            options={PROVIDERS}
            onChange={(p) => update({ aiProvider: p, aiModel: p === 'anthropic' ? 'claude-opus-5-5' : '' })}
          />
          <TextField
            label="Model"
            value={settings.aiModel}
            onChangeText={(m) => update({ aiModel: m })}
            autoCapitalize="none"
            placeholder={settings.aiProvider === 'anthropic' ? 'claude-opus-5-5' : 'název modelu'}
          />
          {settings.aiProvider === 'openai_compatible' ? (
            <TextField label="Adresa serveru" value={settings.aiBaseUrl ?? ''} onChangeText={(u) => update({ aiBaseUrl: u || undefined })} autoCapitalize="none" placeholder="http://192.168.1.10:11434/v1" />
          ) : null}
          <TextField label="API klíč" value={apiKey} onChangeText={setApiKey} secureTextEntry autoCapitalize="none" autoCorrect={false} />
          <Text variant="caption" tone={Platform.OS === 'web' ? 'warning' : 'muted'}>
            {Platform.OS === 'web'
              ? 'Na webu se klíč drží pouze v paměti a po obnovení stránky zmizí. Klíč se odesílá přímo z prohlížeče poskytovateli, používejte klíč s nízkým limitem.'
              : 'Klíč je uložen v zabezpečeném úložišti zařízení (Keychain / Keystore).'}
          </Text>
        </View>
      </Card>
    </Screen>
  );
}
