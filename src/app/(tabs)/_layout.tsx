import { Ionicons } from '@expo/vector-icons';
import { Tabs } from 'expo-router';
import type { ComponentProps } from 'react';
import type { ColorValue } from 'react-native';

import { colors } from '../../theme';

type IconName = ComponentProps<typeof Ionicons>['name'];

interface TabIconProps {
  color: ColorValue;
  focused: boolean;
  size: number;
  active: IconName;
  inactive: IconName;
}

function TabIcon({ color, focused, size, active, inactive }: TabIconProps) {
  return <Ionicons name={focused ? active : inactive} size={size} color={color} />;
}

function tabIcon(active: IconName, inactive: IconName) {
  return function renderTabIcon(props: { color: ColorValue; focused: boolean; size: number }) {
    return <TabIcon {...props} active={active} inactive={inactive} />;
  };
}

/** 底部導覽列：首頁、計畫、進度、設定 */
export default function TabLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.textSecondary,
        tabBarStyle: {
          backgroundColor: colors.background,
          borderTopColor: colors.separator,
        },
        sceneStyle: { backgroundColor: colors.background },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{ title: '首頁', tabBarIcon: tabIcon('home', 'home-outline') }}
      />
      <Tabs.Screen
        name="plan"
        options={{ title: '計畫', tabBarIcon: tabIcon('calendar', 'calendar-outline') }}
      />
      <Tabs.Screen
        name="progress"
        options={{ title: '進度', tabBarIcon: tabIcon('bar-chart', 'bar-chart-outline') }}
      />
      <Tabs.Screen
        name="settings"
        options={{ title: '設定', tabBarIcon: tabIcon('settings', 'settings-outline') }}
      />
      <Tabs.Screen
        name="subscription"
        options={{
          href: null,
          title: '會員方案與權限',
        }}
      />
    </Tabs>
  );
}
