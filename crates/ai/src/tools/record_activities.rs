//! Record Activities tool - create multiple activity drafts in one call.
//!
//! This batch tool reuses `record_activity` normalization/validation logic and
//! returns row-level drafts with a validation summary for a single confirm flow.

use log::debug;
use rig::{completion::ToolDefinition, tool::Tool};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use crate::env::AiEnvironment;
use crate::error::AiError;
use crate::tools::record_activity::{
    AccountOption, ActivityDraft, RecordActivityArgs, RecordActivityTool, ResolvedAsset,
    SubtypeOption, ValidationError, ValidationResult,
};

/// Arguments for the record_activities tool.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordActivitiesArgs {
    /// List of activity intents to normalize into drafts.
    pub activities: Vec<RecordActivityArgs>,
}

/// Batch validation summary.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchValidationSummary {
    pub total_rows: usize,
    pub valid_rows: usize,
    pub error_rows: usize,
}

/// Row-level draft output.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityDraftRow {
    pub row_index: usize,
    pub draft: ActivityDraft,
    pub validation: ValidationResult,
    pub errors: Vec<String>,
    pub resolved_asset: Option<ResolvedAsset>,
    pub available_subtypes: Vec<SubtypeOption>,
}

/// Output envelope for record_activities.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordActivitiesOutput {
    pub drafts: Vec<ActivityDraftRow>,
    pub validation: BatchValidationSummary,
    pub available_accounts: Vec<AccountOption>,
    pub resolved_assets: Vec<ResolvedAsset>,
}

/// Tool to record multiple investment activities from natural language.
pub struct RecordActivitiesTool<E: AiEnvironment> {
    env: Arc<E>,
}

impl<E: AiEnvironment> RecordActivitiesTool<E> {
    pub fn new(env: Arc<E>) -> Self {
        Self { env }
    }
}

impl<E: AiEnvironment> Clone for RecordActivitiesTool<E> {
    fn clone(&self) -> Self {
        Self {
            env: self.env.clone(),
        }
    }
}

impl<E: AiEnvironment + 'static> Tool for RecordActivitiesTool<E> {
    const NAME: &'static str = "record_activities";

    type Error = AiError;
    type Args = RecordActivitiesArgs;
    type Output = RecordActivitiesOutput;

    async fn definition(&self, _prompt: String) -> ToolDefinition {
        ToolDefinition {
            name: Self::NAME.to_string(),
            description: "Record multiple investment transactions from natural language. Returns a read-only batch draft preview for single confirmation.".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "activities": {
                        "type": "array",
                        "description": "List of activities to record together",
                        "items": {
                            "type": "object",
                            "properties": {
                                "activityType": {
                                    "type": "string",
                                    "description": "Activity type: BUY, SELL, DIVIDEND, DEPOSIT, WITHDRAWAL, TRANSFER_IN, TRANSFER_OUT, INTEREST, FEE, SPLIT, TAX, CREDIT, ADJUSTMENT",
                                    "enum": ["BUY", "SELL", "DIVIDEND", "DEPOSIT", "WITHDRAWAL", "TRANSFER_IN", "TRANSFER_OUT", "INTEREST", "FEE", "SPLIT", "TAX", "CREDIT", "ADJUSTMENT", "UNKNOWN"]
                                },
                                "symbol": {
                                    "type": "string",
                                    "description": "Symbol or ticker (e.g., 'AAPL', 'BTC', 'VTI'). Required for BUY/SELL/DIVIDEND/SPLIT"
                                },
                                "activityDate": {
                                    "type": "string",
                                    "description": "ISO 8601 date (e.g., '2026-01-17'). Parse relative dates to ISO format"
                                },
                                "quantity": {
                                    "type": "number",
                                    "description": "Number of shares or units. Required for BUY/SELL/SPLIT"
                                },
                                "unitPrice": {
                                    "type": "number",
                                    "description": "Price per unit"
                                },
                                "amount": {
                                    "type": "number",
                                    "description": "Total amount for cash-style activities"
                                },
                                "fee": {
                                    "type": "number",
                                    "description": "Transaction fee (optional)"
                                },
                                "account": {
                                    "type": "string",
                                    "description": "Account name or ID"
                                },
                                "subtype": {
                                    "type": "string",
                                    "description": "Activity subtype: DRIP, DIVIDEND_IN_KIND, STAKING_REWARD, BONUS"
                                },
                                "notes": {
                                    "type": "string",
                                    "description": "Optional notes"
                                }
                            },
                            "required": ["activityType", "activityDate"]
                        }
                    }
                },
                "required": ["activities"]
            }),
        }
    }

    async fn call(&self, args: Self::Args) -> Result<Self::Output, Self::Error> {
        const MAX_BATCH_SIZE: usize = 100;

        debug!(
            "record_activities called with {} rows",
            args.activities.len()
        );

        if args.activities.is_empty() {
            return Ok(RecordActivitiesOutput {
                drafts: Vec::new(),
                validation: BatchValidationSummary {
                    total_rows: 0,
                    valid_rows: 0,
                    error_rows: 0,
                },
                available_accounts: Vec::new(),
                resolved_assets: Vec::new(),
            });
        }

        if args.activities.len() > MAX_BATCH_SIZE {
            return Err(AiError::ToolExecutionFailed(format!(
                "Batch limited to {} activities, got {}",
                MAX_BATCH_SIZE,
                args.activities.len()
            )));
        }

        // Pre-fetch accounts once for the entire batch.
        let accounts = self
            .env
            .account_service()
            .get_active_accounts()
            .map_err(|e| AiError::ToolExecutionFailed(e.to_string()))?;

        let available_accounts: Vec<AccountOption> = accounts
            .iter()
            .map(|a| AccountOption {
                id: a.id.clone(),
                name: a.name.clone(),
                currency: a.currency.clone(),
            })
            .collect();

        let single_tool = RecordActivityTool::new(self.env.clone());

        // Batch-resolve unique symbols once to avoid N serial API calls.
        let base_currency = self.env.base_currency();
        let unique_symbols: HashSet<String> = args
            .activities
            .iter()
            .filter_map(|a| a.symbol.as_deref())
            .map(|s| s.to_uppercase())
            .collect();
        let mut symbol_cache: HashMap<String, Option<ResolvedAsset>> =
            HashMap::with_capacity(unique_symbols.len());
        for symbol in &unique_symbols {
            let resolved = single_tool
                .resolve_symbol_to_asset(symbol, &base_currency)
                .await;
            symbol_cache.insert(symbol.clone(), resolved);
        }

        let mut drafts = Vec::with_capacity(args.activities.len());

        for (row_index, activity) in args.activities.into_iter().enumerate() {
            match single_tool
                .build_output_with_accounts_and_symbol_cache(activity, &accounts, &symbol_cache)
                .await
            {
                Ok(output) => {
                    let mut row_errors = Vec::new();
                    for field in &output.validation.missing_fields {
                        row_errors.push(format!("Missing required field: {}", field));
                    }
                    for error in &output.validation.errors {
                        row_errors.push(format!("{}: {}", error.field, error.message));
                    }

                    drafts.push(ActivityDraftRow {
                        row_index,
                        draft: output.draft,
                        validation: output.validation,
                        errors: row_errors,
                        resolved_asset: output.resolved_asset,
                        available_subtypes: output.available_subtypes,
                    });
                }
                Err(e) => {
                    drafts.push(ActivityDraftRow {
                        row_index,
                        draft: ActivityDraft {
                            activity_type: "UNKNOWN".to_string(),
                            activity_date: String::new(),
                            symbol: None,
                            asset_id: None,
                            asset_name: None,
                            quantity: None,
                            unit_price: None,
                            amount: None,
                            fee: None,
                            currency: self.env.base_currency(),
                            account_id: None,
                            account_name: None,
                            subtype: None,
                            notes: None,
                            price_source: "none".to_string(),
                            pricing_mode: "MARKET".to_string(),
                            is_custom_asset: false,
                            asset_kind: None,
                        },
                        validation: ValidationResult {
                            is_valid: false,
                            missing_fields: Vec::new(),
                            errors: vec![ValidationError {
                                field: "row".to_string(),
                                message: e.to_string(),
                            }],
                        },
                        errors: vec![e.to_string()],
                        resolved_asset: None,
                        available_subtypes: Vec::new(),
                    });
                }
            }
        }

        let valid_rows = drafts.iter().filter(|d| d.validation.is_valid).count();
        let total_rows = drafts.len();
        let error_rows = total_rows.saturating_sub(valid_rows);

        let mut seen_asset_ids = HashSet::new();
        let resolved_assets: Vec<ResolvedAsset> = drafts
            .iter()
            .filter_map(|row| row.resolved_asset.as_ref())
            .filter_map(|asset| {
                if seen_asset_ids.insert(asset.asset_id.clone()) {
                    Some(asset.clone())
                } else {
                    None
                }
            })
            .collect();

        Ok(RecordActivitiesOutput {
            drafts,
            validation: BatchValidationSummary {
                total_rows,
                valid_rows,
                error_rows,
            },
            available_accounts,
            resolved_assets,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::env::test_env::{MockAccountService, MockEnvironment, MockQuoteService};
    use chrono::Utc;
    use std::sync::RwLock;
    use wealthfolio_core::accounts::Account;
    use wealthfolio_core::quotes::SymbolSearchResult;

    fn account(id: &str, name: &str, currency: &str) -> Account {
        Account {
            id: id.to_string(),
            name: name.to_string(),
            currency: currency.to_string(),
            is_active: true,
            created_at: Utc::now().naive_utc(),
            updated_at: Utc::now().naive_utc(),
            ..Account::default()
        }
    }

    #[tokio::test]
    async fn test_record_activities_all_valid() {
        let mut env = MockEnvironment::new();
        env.account_service = Arc::new(MockAccountService {
            accounts: vec![account("acc-1", "Main Broker", "USD")],
        });
        let tool = RecordActivitiesTool::new(Arc::new(env));

        let output = tool
            .call(RecordActivitiesArgs {
                activities: vec![
                    RecordActivityArgs {
                        activity_type: "DEPOSIT".to_string(),
                        symbol: None,
                        activity_date: "2026-01-17".to_string(),
                        quantity: None,
                        unit_price: None,
                        amount: Some(1000.0),
                        fee: None,
                        account: None,
                        subtype: None,
                        notes: None,
                    },
                    RecordActivityArgs {
                        activity_type: "WITHDRAWAL".to_string(),
                        symbol: None,
                        activity_date: "2026-01-18".to_string(),
                        quantity: None,
                        unit_price: None,
                        amount: Some(500.0),
                        fee: None,
                        account: None,
                        subtype: None,
                        notes: None,
                    },
                ],
            })
            .await
            .expect("batch tool should succeed");

        assert_eq!(output.validation.total_rows, 2);
        assert_eq!(output.validation.valid_rows, 2);
        assert_eq!(output.validation.error_rows, 0);
        assert!(output.drafts.iter().all(|row| row.validation.is_valid));
    }

    #[tokio::test]
    async fn test_record_activities_mixed_valid_invalid_rows() {
        let mut env = MockEnvironment::new();
        env.account_service = Arc::new(MockAccountService {
            accounts: vec![account("acc-1", "Main Broker", "USD")],
        });
        let tool = RecordActivitiesTool::new(Arc::new(env));

        let output = tool
            .call(RecordActivitiesArgs {
                activities: vec![
                    RecordActivityArgs {
                        activity_type: "DEPOSIT".to_string(),
                        symbol: None,
                        activity_date: "2026-01-17".to_string(),
                        quantity: None,
                        unit_price: None,
                        amount: Some(1000.0),
                        fee: None,
                        account: None,
                        subtype: None,
                        notes: None,
                    },
                    RecordActivityArgs {
                        activity_type: "DEPOSIT".to_string(),
                        symbol: None,
                        activity_date: "2026-01-17".to_string(),
                        quantity: None,
                        unit_price: None,
                        amount: None,
                        fee: None,
                        account: None,
                        subtype: None,
                        notes: None,
                    },
                ],
            })
            .await
            .expect("batch tool should succeed");

        assert_eq!(output.validation.total_rows, 2);
        assert_eq!(output.validation.valid_rows, 1);
        assert_eq!(output.validation.error_rows, 1);
        assert!(output.drafts[1]
            .validation
            .missing_fields
            .contains(&"amount".to_string()));
        assert!(!output.drafts[1].errors.is_empty());
    }

    #[tokio::test]
    async fn test_record_activities_auto_select_single_account() {
        let mut env = MockEnvironment::new();
        env.account_service = Arc::new(MockAccountService {
            accounts: vec![account("acc-1", "Only Account", "USD")],
        });
        let tool = RecordActivitiesTool::new(Arc::new(env));

        let output = tool
            .call(RecordActivitiesArgs {
                activities: vec![RecordActivityArgs {
                    activity_type: "DEPOSIT".to_string(),
                    symbol: None,
                    activity_date: "2026-01-17".to_string(),
                    quantity: None,
                    unit_price: None,
                    amount: Some(250.0),
                    fee: None,
                    account: None,
                    subtype: None,
                    notes: None,
                }],
            })
            .await
            .expect("batch tool should succeed");

        assert_eq!(output.drafts.len(), 1);
        assert_eq!(output.drafts[0].draft.account_id, Some("acc-1".to_string()));
        assert_eq!(
            output.drafts[0].draft.account_name,
            Some("Only Account".to_string())
        );
    }

    #[tokio::test]
    async fn test_record_activities_required_fields_by_type() {
        let mut env = MockEnvironment::new();
        env.account_service = Arc::new(MockAccountService {
            accounts: vec![account("acc-1", "Main Broker", "USD")],
        });
        let tool = RecordActivitiesTool::new(Arc::new(env));

        let output = tool
            .call(RecordActivitiesArgs {
                activities: vec![
                    RecordActivityArgs {
                        activity_type: "DEPOSIT".to_string(),
                        symbol: None,
                        activity_date: "2026-01-17".to_string(),
                        quantity: None,
                        unit_price: None,
                        amount: None,
                        fee: None,
                        account: None,
                        subtype: None,
                        notes: None,
                    },
                    RecordActivityArgs {
                        activity_type: "SELL".to_string(),
                        symbol: Some("AAPL".to_string()),
                        activity_date: "2026-01-17".to_string(),
                        quantity: Some(2.0),
                        unit_price: None,
                        amount: None,
                        fee: None,
                        account: None,
                        subtype: None,
                        notes: None,
                    },
                ],
            })
            .await
            .expect("batch tool should succeed");

        assert!(output.drafts[0]
            .validation
            .missing_fields
            .contains(&"amount".to_string()));
        assert!(output.drafts[1]
            .validation
            .missing_fields
            .contains(&"unit_price".to_string()));
    }

    #[tokio::test]
    async fn test_record_activities_deduplicates_symbol_resolution() {
        // Two BUY rows for the same symbol — quote service search result is present once.
        // Both rows should resolve the asset correctly from the shared cache.
        let mut env = MockEnvironment::new();
        env.account_service = Arc::new(MockAccountService {
            accounts: vec![account("acc-1", "Main Broker", "USD")],
        });
        env.quote_service = Arc::new(MockQuoteService {
            search_results: RwLock::new(vec![SymbolSearchResult {
                symbol: "AAPL".to_string(),
                long_name: "Apple Inc.".to_string(),
                exchange_mic: Some("XNAS".to_string()),
                exchange_name: Some("NASDAQ".to_string()),
                currency: Some("USD".to_string()),
                existing_asset_id: Some("SEC:AAPL:XNAS".to_string()),
                ..SymbolSearchResult::default()
            }]),
        });
        let tool = RecordActivitiesTool::new(Arc::new(env));

        let output = tool
            .call(RecordActivitiesArgs {
                activities: vec![
                    RecordActivityArgs {
                        activity_type: "BUY".to_string(),
                        symbol: Some("AAPL".to_string()),
                        activity_date: "2026-01-10".to_string(),
                        quantity: Some(10.0),
                        unit_price: Some(200.0),
                        amount: None,
                        fee: None,
                        account: Some("acc-1".to_string()),
                        subtype: None,
                        notes: None,
                    },
                    RecordActivityArgs {
                        activity_type: "BUY".to_string(),
                        symbol: Some("AAPL".to_string()),
                        activity_date: "2026-01-11".to_string(),
                        quantity: Some(5.0),
                        unit_price: Some(210.0),
                        amount: None,
                        fee: None,
                        account: Some("acc-1".to_string()),
                        subtype: None,
                        notes: None,
                    },
                ],
            })
            .await
            .expect("batch tool should succeed");

        assert_eq!(output.validation.total_rows, 2);
        // Both rows should have resolved the same asset.
        assert_eq!(
            output.drafts[0].draft.asset_id,
            Some("SEC:AAPL:XNAS".to_string())
        );
        assert_eq!(
            output.drafts[1].draft.asset_id,
            Some("SEC:AAPL:XNAS".to_string())
        );
        // Deduplicated resolved_assets list should contain AAPL only once.
        assert_eq!(output.resolved_assets.len(), 1);
        assert_eq!(output.resolved_assets[0].symbol, "AAPL");
    }

    #[tokio::test]
    async fn test_record_activities_subtype_handling() {
        let mut env = MockEnvironment::new();
        env.account_service = Arc::new(MockAccountService {
            accounts: vec![account("acc-1", "Main Broker", "USD")],
        });
        env.quote_service = Arc::new(MockQuoteService {
            search_results: RwLock::new(vec![SymbolSearchResult {
                symbol: "AAPL".to_string(),
                long_name: "Apple Inc.".to_string(),
                exchange_mic: Some("XNAS".to_string()),
                exchange_name: Some("NASDAQ".to_string()),
                currency: Some("USD".to_string()),
                existing_asset_id: Some("SEC:AAPL:XNAS".to_string()),
                ..SymbolSearchResult::default()
            }]),
        });
        let tool = RecordActivitiesTool::new(Arc::new(env));

        let output = tool
            .call(RecordActivitiesArgs {
                activities: vec![
                    RecordActivityArgs {
                        activity_type: "DIVIDEND".to_string(),
                        symbol: Some("AAPL".to_string()),
                        activity_date: "2026-01-17".to_string(),
                        quantity: Some(1.0),
                        unit_price: Some(150.0),
                        amount: None,
                        fee: None,
                        account: None,
                        subtype: Some("DRIP".to_string()),
                        notes: None,
                    },
                    RecordActivityArgs {
                        activity_type: "INTEREST".to_string(),
                        symbol: None,
                        activity_date: "2026-01-17".to_string(),
                        quantity: None,
                        unit_price: None,
                        amount: Some(12.0),
                        fee: None,
                        account: None,
                        subtype: Some("STAKING_REWARD".to_string()),
                        notes: None,
                    },
                    RecordActivityArgs {
                        activity_type: "CREDIT".to_string(),
                        symbol: None,
                        activity_date: "2026-01-17".to_string(),
                        quantity: None,
                        unit_price: None,
                        amount: Some(5.0),
                        fee: None,
                        account: None,
                        subtype: Some("BONUS".to_string()),
                        notes: None,
                    },
                ],
            })
            .await
            .expect("batch tool should succeed");

        assert_eq!(output.drafts[0].draft.subtype.as_deref(), Some("DRIP"));
        assert_eq!(
            output.drafts[1].draft.subtype.as_deref(),
            Some("STAKING_REWARD")
        );
        assert_eq!(output.drafts[2].draft.subtype.as_deref(), Some("BONUS"));
        assert!(output.drafts[0]
            .available_subtypes
            .iter()
            .any(|s| s.value == "DRIP"));
        assert!(output.drafts[1]
            .available_subtypes
            .iter()
            .any(|s| s.value == "STAKING_REWARD"));
        assert!(output.drafts[2]
            .available_subtypes
            .iter()
            .any(|s| s.value == "BONUS"));
    }
}
