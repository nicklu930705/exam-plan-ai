import React, { useEffect, useState } from 'react';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import {
  Alert,
  Linking,
  Pressable,
  StyleSheet,
  View,
} from 'react-native';

import { AppText } from '../../components/AppText';
import { Button } from '../../components/Button';
import { Screen } from '../../components/Screen';
import { ScreenHeader } from '../../components/ScreenHeader';
import { useAppStore } from '../../store/AppStore';
import { getEffectiveTier, getPlanEntitlements } from '../../subscription/entitlements';
import { SUBSCRIPTION_PRODUCTS } from '../../subscription/products';
import {
  APPLE_MANAGE_SUBSCRIPTIONS_URL,
  isIapSandboxConfigured,
  isSandboxIapAllowed,
  STOREKIT_PRODUCT_IDS,
} from '../../subscription/storeKitConfig';
import { storeKitService, type StoreStatus } from '../../subscription/storeKitService';
import type { PlanTier, ProductDefinition, UserSubscription } from '../../subscription/types';
import { colors, radius, shadow, spacing } from '../../theme';

export default function SubscriptionScreen() {
  const { data, setSubscription } = useAppStore();
  const currentTier = getEffectiveTier(data.subscription);
  const currentSub = data.subscription;
  const currentEntitlements = getPlanEntitlements(currentTier);

  const [products, setProducts] = useState<ProductDefinition[]>(SUBSCRIPTION_PRODUCTS);
  const [storeStatus, setStoreStatus] = useState<StoreStatus>(storeKitService.getStoreStatus());

  // 預設選中 Pro 年繳方案或使用者目前方案
  const [selectedProductId, setSelectedProductId] = useState<string>(
    currentTier === 'lifetime'
      ? STOREKIT_PRODUCT_IDS.LIFETIME
      : currentTier === 'pro'
        ? currentSub?.billingCycle === 'monthly'
          ? STOREKIT_PRODUCT_IDS.MONTHLY
          : STOREKIT_PRODUCT_IDS.YEARLY
        : STOREKIT_PRODUCT_IDS.YEARLY,
  );

  const [isLoading, setIsLoading] = useState(false);
  const [isRestoring, setIsRestoring] = useState(false);

  // Apple IAP 沙盒環境狀態檢查
  const isSandboxConfigured = isIapSandboxConfigured();
  const isSandboxAllowed = isSandboxIapAllowed();
  const isSandboxMisconfigured = isSandboxConfigured && !isSandboxAllowed;

  // 判斷該商品是否為使用者目前正在生效的方案
  const isProductCurrent = (product: ProductDefinition) => {
    if (product.tier === 'free') {
      return currentTier === 'free';
    }
    if (product.tier === 'lifetime') {
      return currentTier === 'lifetime';
    }
    if (product.tier === 'pro') {
      return (
        currentTier === 'pro' &&
        currentSub?.billingCycle === product.period
      );
    }
    return false;
  };

  // 載入 StoreKit 在地化價格與環境狀態
  useEffect(() => {
    let isMounted = true;
    async function loadStoreProducts() {
      try {
        const loaded = await storeKitService.getProducts();
        if (isMounted && loaded && loaded.length > 0) {
          setProducts(loaded);
        }
        if (isMounted) {
          setStoreStatus(storeKitService.getStoreStatus());
        }
      } catch {
        // 失敗時維持預設配置
      }
    }
    loadStoreProducts();
    return () => {
      isMounted = false;
    };
  }, []);

  const selectedProduct =
    products.find((p) => p.id === selectedProductId) ?? products[2];
  const isSelectedProductCurrent = isProductCurrent(selectedProduct);

  // 處理返回設定頁面
  const handleBackToSettings = () => {
    if (router.canGoBack()) {
      router.back();
    } else {
      router.push('/(tabs)/settings');
    }
  };

  // 處理方案購買流程
  const handlePurchase = async () => {
    // 1. 若宣告啟用 Sandbox 但環境不合規（如 URL 未設或誤指正式環境），安全阻斷
    if (isSandboxMisconfigured) {
      Alert.alert(
        'Sandbox 環境設定錯誤',
        '此建置宣告啟用 Sandbox 內購測試，但後端網址未設定或不符合指定之 Sandbox URL，已安全阻斷購買，絕不連線至正式後端。',
      );
      return;
    }

    // 2. 一般正式版安全防護：未在開發環境且非合規 Sandbox 測試版時，停用付費購買入口
    if (!__DEV__ && !isSandboxAllowed && selectedProduct.tier !== 'free') {
      Alert.alert(
        '尚未開放付費購買',
        '目前為 TestFlight 測試預覽版本，付費功能暫未開放。所有核心讀書計畫排程、計時器、進度追蹤與 AI 讀書建議皆可免費完整體驗！',
      );
      return;
    }

    setIsLoading(true);
    try {
      const result = await storeKitService.purchase(selectedProductId);

      if (result.status === 'success' && result.subscription) {
        setSubscription(result.subscription);
        Alert.alert('方案開通成功', result.message, [
          { text: '確定', onPress: () => router.push('/(tabs)/settings') },
        ]);
      } else if (result.status === 'cancelled') {
        // 使用者主動取消，安靜處理不彈出驚擾式錯誤視窗
      } else if (result.status === 'deferred') {
        Alert.alert('等待處理中', result.message);
      } else {
        Alert.alert('交易未能完成', result.message || '請確認網路連線或 App Store 帳號狀態後再試。');
      }
    } catch {
      Alert.alert('處理失敗', '無法完成方案處理，請稍後再試。');
    } finally {
      setIsLoading(false);
    }
  };

  // 處理恢復購買 (兩階段策略：優先查詢本機安全憑證快取，查無紀錄時引導向 Apple 伺服器深度同步)
  const handleRestore = async (options?: { syncWithAppStore?: boolean }) => {
    // 1. 若宣告啟用 Sandbox 但環境不合規，安全阻斷
    if (isSandboxMisconfigured) {
      Alert.alert(
        'Sandbox 環境設定錯誤',
        '此建置宣告啟用 Sandbox 內購測試，但後端網址未設定或不符合指定之 Sandbox URL，已安全阻斷恢復購買。',
      );
      return;
    }

    // 2. 一般正式版安全防護：未在開發環境且非合規 Sandbox 測試版時提示使用者
    if (!__DEV__ && !isSandboxAllowed) {
      Alert.alert(
        '尚未開放付費功能',
        '目前 TestFlight 版本尚未開放付費購買，暫無可恢復的 App Store 訂閱紀錄。',
      );
      return;
    }

    setIsRestoring(true);
    try {
      const restoreOpts =
        options && typeof options === 'object' && typeof options.syncWithAppStore === 'boolean'
          ? options
          : undefined;

      const result = await storeKitService.restorePurchases(restoreOpts);

      if (result.status === 'success' && result.subscription) {
        setSubscription(result.subscription);
        Alert.alert('恢復成功', result.message);
      } else if (result.status === 'expired' && result.subscription) {
        setSubscription(result.subscription);
        Alert.alert('訂閱過期通知', result.message);
      } else if (result.status === 'needs_sync') {
        // 本機快取無購買紀錄，主動詢問使用者是否執行 Apple 伺服器深度同步
        Alert.alert(
          '未查到本機購買紀錄',
          result.message || '本機未查到有效訂閱紀錄。若您先前曾購買過，是否向 Apple 伺服器重新同步？',
          [
            { text: '取消', style: 'cancel' },
            {
              text: '向 Apple 伺服器同步',
              onPress: () => {
                handleRestore({ syncWithAppStore: true });
              },
            },
          ],
        );
      } else if (result.status === 'no_purchases') {
        Alert.alert('恢復購買結果', result.message);
      } else if (result.status === 'sync_error') {
        // Code 14 或 StoreKit 暫時錯誤：友善說明，保留本機狀態，指引檢查設定
        Alert.alert(
          'Apple 伺服器同步暫時中斷',
          (result.message || 'Apple App Store 伺服器同步暫時中斷。') +
            '\n\n您可稍後再次嘗試，或前往 iPhone「設定 → Apple 帳號 → 訂閱項目」確認您的訂閱狀態。',
          [
            { text: '確定', style: 'default' },
            {
              text: '重試同步',
              onPress: () => handleRestore({ syncWithAppStore: true }),
            },
          ],
        );
      } else if (result.status === 'verification_failed') {
        Alert.alert(
          '安全驗證未通過',
          result.message || 'Apple 交易憑證未能通過伺服器驗證，無法恢復會員權益。',
        );
      } else if (result.status === 'cancelled') {
        // 使用者主動取消，安靜處理
      } else if (result.status === 'busy') {
        Alert.alert('處理中', result.message || '恢復購買程序正在進行中，請稍候。');
      } else {
        Alert.alert(
          '恢復未能完成',
          result.message || '無法從 App Store 恢復購買，請稍後再試。',
        );
      }
    } catch {
      Alert.alert('處理失敗', '無法完成恢復購買，請確認網路連線。');
    } finally {
      setIsRestoring(false);
    }
  };

  // 開啟 Apple 官方訂閱管理頁面
  const handleManageSubscriptions = async () => {
    const res = await storeKitService.manageSubscriptions();
    if (!res.success) {
      if (res.status === 'dev_preview') {
        Alert.alert('開發預覽模式', res.error || '開發測試模式下無真實 Apple 訂閱。');
      } else if (res.status === 'unsupported_platform') {
        Alert.alert('不支援的平台', res.error || '目前僅支援 iOS 裝置管理 Apple 訂閱。');
      } else {
        Alert.alert(
          '無法直接開啟訂閱管理',
          '未能直接開啟 Apple 原生訂閱管理視窗。\n\n【TestFlight 沙盒測試者】\n請前往 iPhone「設定 → App Store → 沙盒帳號」檢視或取消測試訂閱。\n\n【正式帳號用戶】\n若為正式 App Store 購買，可開啟系統訂閱頁。（注意：該頁僅顯示正式 Apple ID 訂閱，不包含沙盒測試項目）',
          [
            { text: '知道了', style: 'cancel' },
            {
              text: '開啟正式訂閱頁',
              onPress: () => {
                Linking.openURL(APPLE_MANAGE_SUBSCRIPTIONS_URL).catch(() => {});
              },
            },
          ],
        );
      }
    }
  };

  // 開發者測試用：一鍵切換方案狀態（僅在開發環境有效）
  const handleQuickSwitch = (
    tier: PlanTier,
    cycle: 'monthly' | 'annual' | 'none' | 'lifetime',
    expired = false,
  ) => {
    if (!__DEV__) {
      return;
    }
    let sub: UserSubscription;
    const now = new Date();
    if (expired) {
      const past = new Date(now.getTime() - 24 * 3600 * 1000).toISOString();
      sub = {
        plan: 'pro',
        billingCycle: 'monthly',
        status: 'expired',
        expiresAt: past,
        isDevPreview: true,
      };
    } else if (tier === 'free') {
      sub = {
        plan: 'free',
        billingCycle: 'none',
        status: 'none',
        isDevPreview: true,
      };
    } else if (tier === 'lifetime') {
      sub = {
        plan: 'lifetime',
        billingCycle: 'lifetime',
        status: 'active',
        isDevPreview: true,
      };
    } else {
      const future = new Date(
        now.getTime() + (cycle === 'annual' ? 365 : 30) * 24 * 3600 * 1000,
      ).toISOString();
      sub = {
        plan: 'pro',
        billingCycle: cycle,
        status: 'active',
        expiresAt: future,
        isDevPreview: true,
      };
    }

    setSubscription(sub);
    Alert.alert(
      '測試方案已切換',
      expired
        ? '已模擬 Pro 方案過期狀態（將自動降級至 Free 權限，既有資料完好保存）。'
        : `已將當前方案切換為「${sub.plan.toUpperCase()}（${sub.billingCycle}）」。`,
    );
  };

  return (
    <Screen topInset contentStyle={styles.screenContent}>
      {/* 頂部導航列：支援返回設定 */}
      <View style={styles.topNavRow}>
        <Pressable
          onPress={handleBackToSettings}
          hitSlop={12}
          style={styles.backButton}
          accessibilityRole="button"
          accessibilityLabel="返回設定"
        >
          <Ionicons name="chevron-back" size={22} color={colors.primary} />
          <AppText style={styles.backButtonText}>設定</AppText>
        </Pressable>
      </View>

      <ScreenHeader
        title="會員方案"
        subtitle="升級 Pro 或永久買斷，掌握高效備考節奏"
      />

      {/* StoreKit 連線與環境狀態說明卡片（僅開發環境顯示） */}
      {__DEV__ && (
        <View
          style={[
            styles.statusNoticeCard,
            storeStatus.isNativeAvailable
              ? styles.statusNoticeCardActive
              : styles.statusNoticeCardPreview,
          ]}
        >
          <View style={styles.statusNoticeHeader}>
            <View
              style={[
                styles.statusNoticeBadge,
                storeStatus.isNativeAvailable
                  ? styles.statusNoticeBadgeActive
                  : styles.statusNoticeBadgePreview,
              ]}
            >
              <AppText style={styles.statusNoticeBadgeText}>
                {storeStatus.isNativeAvailable
                  ? 'Apple StoreKit 2 就緒'
                  : '開發預覽 / Expo Go 模式'}
              </AppText>
            </View>
          </View>
          <AppText secondary style={styles.statusNoticeText}>
            {storeStatus.notice}
          </AppText>
        </View>
      )}

      {/* 當前會員狀態卡片 */}
      <View style={styles.currentCard}>
        <View style={styles.currentRow}>
          <View>
            <AppText secondary style={styles.currentLabel}>
              目前有效身分
            </AppText>
            <AppText variant="title" style={styles.currentTier}>
              {currentEntitlements.displayName}
            </AppText>
          </View>
          <View
            style={[
              styles.tierBadge,
              currentTier === 'free' ? styles.tierBadgeFree : styles.tierBadgePro,
            ]}
          >
            <AppText
              style={[
                styles.tierBadgeText,
                currentTier === 'free' ? styles.tierBadgeTextFree : styles.tierBadgeTextPro,
              ]}
            >
              {currentTier === 'lifetime'
                ? '永久授權'
                : currentTier === 'pro'
                  ? currentSub?.status === 'canceled'
                    ? '已取消續訂（效期內有效）'
                    : '有效訂閱中'
                  : '免費體驗中'}
            </AppText>
          </View>
        </View>

        {currentSub?.expiresAt && currentTier === 'pro' && (
          <AppText secondary style={styles.expiresText}>
            有效期限至：{new Date(currentSub.expiresAt).toLocaleDateString()}
          </AppText>
        )}
        {currentSub?.status === 'expired' && currentTier === 'free' && currentSub?.expiresAt && (
          <AppText secondary style={styles.expiresText}>
            先前訂閱已於 {new Date(currentSub.expiresAt).toLocaleDateString()} 到期（功能已切換回免費版）
          </AppText>
        )}

        <View style={styles.statusDivider} />

        {/* AI 用量與考試額度摘要 */}
        <View style={styles.usageRow}>
          <View style={styles.usageCol}>
            <AppText secondary style={styles.usageLabel}>
              進行中考試
            </AppText>
            <AppText style={styles.usageValue}>
              {data.exams.filter((e) => !e.archived).length} /{' '}
              {currentEntitlements.maxActiveExams === Infinity
                ? '無限制'
                : currentEntitlements.maxActiveExams}
            </AppText>
          </View>
          <View style={styles.usageCol}>
            <AppText secondary style={styles.usageLabel}>
              AI 每日雲端額度
            </AppText>
            <AppText style={styles.usageValue}>
              {currentTier === 'free' ? '每日 3 次' : '每日 15 次'}
            </AppText>
          </View>
        </View>
      </View>

      {/* 方案選擇卡片清單 */}
      <AppText variant="headline" style={styles.sectionHeading}>
        選擇適合的備考方案
      </AppText>

      <View style={styles.productList}>
        {products.map((product) => {
          const isSelected = selectedProductId === product.id;
          const isCurrent = isProductCurrent(product);
          return (
            <Pressable
              key={product.id}
              disabled={isLoading || isRestoring}
              onPress={() => setSelectedProductId(product.id)}
              style={[
                styles.productCard,
                isSelected && styles.productCardSelected,
                isCurrent && styles.productCardCurrent,
              ]}
            >
              {isCurrent ? (
                <View style={[styles.productBadge, styles.productBadgeCurrent]}>
                  <Ionicons name="checkmark-circle" size={11} color="#FFFFFF" style={{ marginRight: 3 }} />
                  <AppText style={styles.productBadgeText}>目前使用中</AppText>
                </View>
              ) : product.badge ? (
                <View style={styles.productBadge}>
                  <AppText style={styles.productBadgeText}>{product.badge}</AppText>
                </View>
              ) : null}

              <View style={styles.productHeader}>
                <View style={styles.productTitleCol}>
                  <AppText variant="headline" style={styles.productTitle}>
                    {product.title}
                  </AppText>
                  <AppText secondary style={styles.productDesc}>
                    {product.description}
                  </AppText>
                </View>

                <View style={styles.productPriceCol}>
                  <AppText variant="headline" style={styles.productPrice}>
                    {product.priceFormatted}
                  </AppText>
                  <View
                    style={[
                      styles.radioOuter,
                      isSelected && styles.radioOuterSelected,
                      isCurrent && styles.radioOuterCurrent,
                    ]}
                  >
                    {isCurrent ? (
                      <Ionicons name="checkmark" size={13} color={colors.primary} />
                    ) : isSelected ? (
                      <View style={styles.radioInner} />
                    ) : null}
                  </View>
                </View>
              </View>

              {/* 特色條列 */}
              <View style={styles.featureList}>
                {product.features.map((feat, idx) => (
                  <View key={idx} style={styles.featureRow}>
                    <AppText style={styles.featureCheck}>✓</AppText>
                    <AppText style={styles.featureText}>{feat}</AppText>
                  </View>
                ))}
              </View>
            </Pressable>
          );
        })}
      </View>

      {/* 核心功能對比表 */}
      <AppText variant="headline" style={styles.sectionHeading}>
        完整功能對比
      </AppText>

      <View style={styles.matrixCard}>
        <View style={styles.matrixHeaderRow}>
          <AppText style={[styles.matrixCell, styles.matrixColFeature]}>功能項目</AppText>
          <AppText style={[styles.matrixCell, styles.matrixColTier]}>Free</AppText>
          <AppText style={[styles.matrixCell, styles.matrixColTier]}>Pro</AppText>
          <AppText style={[styles.matrixCell, styles.matrixColTier]}>Lifetime</AppText>
        </View>

        <MatrixRow
          feature="進行中考試數量"
          free="1 場"
          pro="無限制"
          lifetime="無限制"
        />
        <MatrixRow
          feature="基礎自動排程與計時"
          free="✓"
          pro="✓"
          lifetime="✓"
        />
        <MatrixRow
          feature="智慧重新排程 (負載平衡)"
          free="—"
          pro="✓"
          lifetime="✓"
        />
        <MatrixRow
          feature="AI 讀書教練建議"
          free="每日 3 次"
          pro="每日 15 次"
          lifetime="每日 15 次"
        />
        <MatrixRow
          feature="弱科深度衝刺規劃"
          free="—"
          pro="✓"
          lifetime="✓"
        />
        <MatrixRow
          feature="進階多維度學習報告"
          free="基本統計"
          pro="完整進階"
          lifetime="完整進階"
        />
        <MatrixRow
          feature="未來雲端跨裝置同步"
          free="—"
          pro="享有權益"
          lifetime="保留本機"
          isLast
        />
      </View>

      {/* 依建置環境顯示對應說明卡片 */}
      {isSandboxAllowed ? (
        <View style={styles.sandboxNoticeCard}>
          <View style={styles.sandboxNoticeHeader}>
            <Ionicons
              name="flask"
              size={18}
              color="#B45309"
              style={{ marginRight: 6 }}
            />
            <AppText style={styles.sandboxNoticeTitle}>
              Apple StoreKit 2 沙盒測試環境
            </AppText>
          </View>
          <AppText secondary style={styles.sandboxNoticeText}>
            本版本已連線至獨立 Sandbox 驗證伺服器，並啟用 StoreKit 2 測試購買。請使用 Apple Sandbox 測試帳號驗證交易，不會產生任何真實扣款。
          </AppText>
        </View>
      ) : isSandboxMisconfigured ? (
        <View style={styles.sandboxErrorNoticeCard}>
          <View style={styles.sandboxNoticeHeader}>
            <Ionicons
              name="warning"
              size={18}
              color={colors.danger}
              style={{ marginRight: 6 }}
            />
            <AppText style={[styles.sandboxNoticeTitle, { color: colors.danger }]}>
              Sandbox 環境設定異常
            </AppText>
          </View>
          <AppText secondary style={[styles.sandboxNoticeText, { color: colors.danger }]}>
            已開啟 Sandbox 測試旗標，但後端網址不符合指定之 Sandbox URL。為防止污染正式環境，系統已全面阻斷所有購買與 API 請求。
          </AppText>
        </View>
      ) : !__DEV__ ? (
        <View style={styles.testFlightNoticeCard}>
          <View style={styles.testFlightNoticeHeader}>
            <Ionicons
              name="information-circle"
              size={18}
              color={colors.primary}
              style={{ marginRight: 6 }}
            />
            <AppText style={styles.testFlightNoticeTitle}>
              TestFlight 測試階段說明
            </AppText>
          </View>
          <AppText secondary style={styles.testFlightNoticeText}>
            目前為 TestFlight 測試預覽版本，付費方案暫未開放購買。所有核心讀書計畫排程、計時器、任務進度追蹤與 AI 讀書建議皆可免費完整體驗！
          </AppText>
        </View>
      ) : null}

      {/* 購買與管理操作按鈕 */}
      <View style={styles.actionContainer}>
        <Button
          title={
            isLoading
              ? '處理中...'
              : isSandboxMisconfigured
                ? 'Sandbox 設定錯誤・已安全阻斷'
                : !__DEV__ && !isSandboxAllowed && selectedProduct.tier !== 'free'
                  ? 'TestFlight 測試階段・暫未開放購買'
                  : isSelectedProductCurrent
                    ? '目前已是此方案'
                    : isSandboxAllowed
                      ? `以 ${selectedProduct.priceFormatted} 測試購買方案`
                      : `以 ${selectedProduct.priceFormatted} 切換方案`
          }
          loading={isLoading}
          onPress={handlePurchase}
          disabled={
            isLoading ||
            isRestoring ||
            isSelectedProductCurrent ||
            isSandboxMisconfigured ||
            (!__DEV__ && !isSandboxAllowed && selectedProduct.tier !== 'free')
          }
          style={styles.mainActionButton}
        />

        <View style={styles.actionButtonsRow}>
          <Pressable
            onPress={() => handleRestore()}
            disabled={isLoading || isRestoring}
            style={styles.secondaryActionBtn}
          >
            <AppText
              style={[
                styles.secondaryActionText,
                isRestoring && { color: colors.primary, fontWeight: '600' },
              ]}
            >
              {isRestoring ? '恢復處理中...' : '恢復購買 (Restore Purchases)'}
            </AppText>
          </Pressable>

          <AppText secondary style={styles.actionDivider}>
            ・
          </AppText>

          <Pressable
            onPress={handleManageSubscriptions}
            disabled={isLoading || isRestoring}
            style={styles.secondaryActionBtn}
          >
            <AppText style={styles.secondaryActionText}>
              管理 Apple 訂閱項目
            </AppText>
          </Pressable>
        </View>
      </View>

      {/* 開發者即時方案切換控制台（僅在 __DEV__ 開發環境顯示，正式發行版隱藏） */}
      {__DEV__ && (
        <View style={styles.devToolSection}>
          <AppText style={styles.devToolTitle}>開發者測試控制台</AppText>
          <AppText secondary style={styles.devToolDesc}>
            點擊可立即模擬切換會員狀態，驗證多考試限制、排程開關與過期降級防護：
          </AppText>
          <View style={styles.devButtonGrid}>
            <Pressable
              style={styles.devBtn}
              onPress={() => handleQuickSwitch('free', 'none')}
            >
              <AppText style={styles.devBtnText}>免費版 (Free)</AppText>
            </Pressable>
            <Pressable
              style={styles.devBtn}
              onPress={() => handleQuickSwitch('pro', 'monthly')}
            >
              <AppText style={styles.devBtnText}>Pro 月繳</AppText>
            </Pressable>
            <Pressable
              style={styles.devBtn}
              onPress={() => handleQuickSwitch('pro', 'annual')}
            >
              <AppText style={styles.devBtnText}>Pro 年繳</AppText>
            </Pressable>
            <Pressable
              style={styles.devBtn}
              onPress={() => handleQuickSwitch('lifetime', 'lifetime')}
            >
              <AppText style={styles.devBtnText}>終身版 (Lifetime)</AppText>
            </Pressable>
            <Pressable
              style={[styles.devBtn, styles.devBtnWarn]}
              onPress={() => handleQuickSwitch('pro', 'monthly', true)}
            >
              <AppText style={[styles.devBtnText, styles.devBtnWarnText]}>
                模擬過期 (降級)
              </AppText>
            </Pressable>
          </View>
        </View>
      )}

      {/* 條款與宣告 */}
      <View style={styles.legalSection}>
        <View style={styles.legalLinksRow}>
          <Pressable onPress={() => router.push('/terms')}>
            <AppText style={styles.legalLinkText}>服務條款</AppText>
          </Pressable>
          <AppText secondary style={styles.legalLinkDivider}>
            ・
          </AppText>
          <Pressable onPress={() => router.push('/privacy')}>
            <AppText style={styles.legalLinkText}>隱私權政策</AppText>
          </Pressable>
        </View>

        <AppText secondary style={styles.legalDisclaimer}>
          訂閱服務將透過您的 Apple ID 帳戶自動扣款與續約。您可隨時至 iPhone「設定 → Apple
          ID → 訂閱項目」取消或管理訂閱。方案到期或更換不會刪除您的任何本機資料與歷史考試紀錄。
        </AppText>
      </View>
    </Screen>
  );
}

function MatrixRow({
  feature,
  free,
  pro,
  lifetime,
  isLast = false,
}: {
  feature: string;
  free: string;
  pro: string;
  lifetime: string;
  isLast?: boolean;
}) {
  return (
    <View style={[styles.matrixRow, !isLast && styles.matrixRowBorder]}>
      <AppText style={[styles.matrixCell, styles.matrixColFeature, styles.matrixFeatureText]}>
        {feature}
      </AppText>
      <AppText
        secondary={free === '—'}
        style={[
          styles.matrixCell,
          styles.matrixColTier,
          free === '✓' ? styles.matrixGreen : undefined,
        ]}
      >
        {free}
      </AppText>
      <AppText
        style={[
          styles.matrixCell,
          styles.matrixColTier,
          pro === '✓' ? styles.matrixGreen : undefined,
        ]}
      >
        {pro}
      </AppText>
      <AppText
        style={[
          styles.matrixCell,
          styles.matrixColTier,
          lifetime === '✓' ? styles.matrixGreen : undefined,
        ]}
      >
        {lifetime}
      </AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  screenContent: {
    paddingBottom: spacing.xxl * 2,
  },
  topNavRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: spacing.sm,
  },
  backButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.xs,
    paddingRight: spacing.sm,
    marginLeft: -spacing.xs,
  },
  backButtonText: {
    color: colors.primary,
    fontSize: 16,
    fontWeight: '600',
  },
  statusNoticeCard: {
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.lg,
  },
  statusNoticeCardActive: {
    backgroundColor: '#F3F8F4',
    borderColor: '#CDE5D4',
  },
  statusNoticeCardPreview: {
    backgroundColor: '#FAF5EA',
    borderColor: '#EBDCB9',
  },
  testFlightNoticeCard: {
    backgroundColor: '#F3F8F4',
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.lg,
    borderWidth: 1,
    borderColor: '#CDE5D4',
  },
  testFlightNoticeHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 4,
  },
  testFlightNoticeTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: colors.primary,
  },
  testFlightNoticeText: {
    fontSize: 12,
    lineHeight: 18,
    color: colors.textSecondary,
  },
  sandboxNoticeCard: {
    backgroundColor: '#FEF9EE',
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.lg,
    borderWidth: 1,
    borderColor: '#FDE68A',
  },
  sandboxErrorNoticeCard: {
    backgroundColor: '#FEF2F2',
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.lg,
    borderWidth: 1,
    borderColor: '#FECACA',
  },
  sandboxNoticeHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 4,
  },
  sandboxNoticeTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: '#B45309',
  },
  sandboxNoticeText: {
    fontSize: 12,
    lineHeight: 18,
    color: '#92400E',
  },
  statusNoticeHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 4,
  },
  statusNoticeBadge: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radius.pill,
  },
  statusNoticeBadgeActive: {
    backgroundColor: colors.primary,
  },
  statusNoticeBadgePreview: {
    backgroundColor: '#8C6C38',
  },
  statusNoticeBadgeText: {
    color: '#FFFFFF',
    fontSize: 11,
    fontWeight: '700',
  },
  statusNoticeText: {
    fontSize: 12,
    lineHeight: 18,
    marginTop: 4,
  },
  currentCard: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: spacing.lg,
    marginBottom: spacing.xl,
    ...shadow.sm,
  },
  currentRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  currentLabel: {
    fontSize: 12,
    marginBottom: 2,
  },
  currentTier: {
    color: colors.text,
  },
  tierBadge: {
    paddingHorizontal: spacing.md,
    paddingVertical: 4,
    borderRadius: radius.pill,
  },
  tierBadgeFree: {
    backgroundColor: '#ECEAE1',
  },
  tierBadgePro: {
    backgroundColor: colors.primarySoft,
  },
  tierBadgeText: {
    fontSize: 12,
    fontWeight: '600',
  },
  tierBadgeTextFree: {
    color: colors.textSecondary,
  },
  tierBadgeTextPro: {
    color: colors.primary,
  },
  expiresText: {
    fontSize: 12,
    marginTop: spacing.xs,
  },
  statusDivider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.separator,
    marginVertical: spacing.md,
  },
  usageRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  usageCol: {
    flex: 1,
  },
  usageLabel: {
    fontSize: 12,
    marginBottom: 2,
  },
  usageValue: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.text,
  },
  sectionHeading: {
    marginBottom: spacing.md,
    color: colors.text,
  },
  productList: {
    gap: spacing.md,
    marginBottom: spacing.xl,
  },
  productCard: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: spacing.lg,
    borderWidth: 1.5,
    borderColor: 'transparent',
    ...shadow.sm,
  },
  productCardSelected: {
    borderColor: colors.primary,
    backgroundColor: '#FAFBF9',
  },
  productCardCurrent: {
    borderColor: '#7F9A83',
    backgroundColor: '#F5F8F5',
  },
  productBadge: {
    position: 'absolute',
    top: -10,
    right: spacing.lg,
    backgroundColor: colors.primary,
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    borderRadius: radius.pill,
    zIndex: 10,
  },
  productBadgeCurrent: {
    backgroundColor: '#4B6B52',
    flexDirection: 'row',
    alignItems: 'center',
  },
  productBadgeText: {
    color: colors.onPrimary,
    fontSize: 11,
    fontWeight: '700',
  },
  productHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: spacing.md,
  },
  productTitleCol: {
    flex: 1,
    paddingRight: spacing.sm,
  },
  productTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: colors.text,
  },
  productDesc: {
    fontSize: 12,
    marginTop: 2,
    lineHeight: 16,
  },
  productPriceCol: {
    alignItems: 'flex-end',
    gap: spacing.xs,
  },
  productPrice: {
    fontSize: 15,
    fontWeight: '700',
    color: colors.primary,
  },
  radioOuter: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 2,
    borderColor: colors.separator,
    alignItems: 'center',
    justifyContent: 'center',
  },
  radioOuterSelected: {
    borderColor: colors.primary,
  },
  radioOuterCurrent: {
    borderColor: colors.primary,
    backgroundColor: '#EDF4EE',
  },
  radioInner: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: colors.primary,
  },
  featureList: {
    paddingTop: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.separator,
    gap: 4,
  },
  featureRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  featureCheck: {
    color: colors.primary,
    fontSize: 13,
    fontWeight: '700',
  },
  featureText: {
    fontSize: 13,
    color: colors.text,
  },
  matrixCard: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.xl,
    ...shadow.sm,
  },
  matrixHeaderRow: {
    flexDirection: 'row',
    paddingBottom: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.separator,
  },
  matrixRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.sm,
  },
  matrixRowBorder: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.separator,
  },
  matrixCell: {
    fontSize: 12,
    textAlign: 'center',
  },
  matrixColFeature: {
    flex: 2.2,
    textAlign: 'left',
  },
  matrixColTier: {
    flex: 1.1,
  },
  matrixFeatureText: {
    fontWeight: '500',
    color: colors.text,
  },
  matrixGreen: {
    color: colors.primary,
    fontWeight: '700',
  },
  actionContainer: {
    marginBottom: spacing.xl,
    gap: spacing.md,
  },
  mainActionButton: {
    width: '100%',
  },
  actionButtonsRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: spacing.xs,
  },
  secondaryActionBtn: {
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.xs,
  },
  secondaryActionText: {
    color: colors.textSecondary,
    fontSize: 13,
    fontWeight: '500',
  },
  actionDivider: {
    marginHorizontal: spacing.xs,
  },
  devToolSection: {
    backgroundColor: '#F3F4EE',
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.xl,
    borderWidth: 1,
    borderColor: '#E3E5DD',
  },
  devToolTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: colors.text,
    marginBottom: 2,
  },
  devToolDesc: {
    fontSize: 11,
    lineHeight: 16,
    marginBottom: spacing.sm,
  },
  devButtonGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
  },
  devBtn: {
    backgroundColor: colors.surface,
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.separator,
  },
  devBtnText: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.text,
  },
  devBtnWarn: {
    borderColor: '#D4A373',
    backgroundColor: '#FFF9F2',
  },
  devBtnWarnText: {
    color: '#9C6634',
  },
  legalSection: {
    alignItems: 'center',
    paddingBottom: spacing.lg,
  },
  legalLinksRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: spacing.sm,
  },
  legalLinkText: {
    color: colors.primary,
    fontSize: 13,
    fontWeight: '500',
  },
  legalLinkDivider: {
    marginHorizontal: spacing.sm,
  },
  legalDisclaimer: {
    fontSize: 11,
    lineHeight: 16,
    textAlign: 'center',
    paddingHorizontal: spacing.md,
  },
});
