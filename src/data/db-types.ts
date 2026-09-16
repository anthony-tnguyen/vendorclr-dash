export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5";
  };
  public: {
    Tables: {
      audit_log: {
        Row: {
          action: string;
          actor_id: string | null;
          company_id: string;
          created_at: string;
          detail: Json;
          id: string;
          target_id: string;
          target_type: string;
        };
        Insert: {
          action: string;
          actor_id?: string | null;
          company_id: string;
          created_at?: string;
          detail?: Json;
          id?: string;
          target_id: string;
          target_type: string;
        };
        Update: {
          action?: string;
          actor_id?: string | null;
          company_id?: string;
          created_at?: string;
          detail?: Json;
          id?: string;
          target_id?: string;
          target_type?: string;
        };
        Relationships: [
          {
            foreignKeyName: "audit_log_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "admin_company_stats";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "audit_log_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "companies";
            referencedColumns: ["id"];
          },
        ];
      };
      companies: {
        Row: {
          created_at: string;
          id: string;
          name: string;
          plan: string;
          subscription_renews_on: string | null;
          updated_at: string;
        };
        Insert: {
          created_at?: string;
          id?: string;
          name: string;
          plan?: string;
          subscription_renews_on?: string | null;
          updated_at?: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          name?: string;
          plan?: string;
          subscription_renews_on?: string | null;
          updated_at?: string;
        };
        Relationships: [];
      };
      company_feature_flags: {
        Row: {
          company_id: string;
          enabled: boolean;
          key: string;
          updated_at: string;
        };
        Insert: {
          company_id: string;
          enabled?: boolean;
          key: string;
          updated_at?: string;
        };
        Update: {
          company_id?: string;
          enabled?: boolean;
          key?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "company_feature_flags_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "admin_company_stats";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "company_feature_flags_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "companies";
            referencedColumns: ["id"];
          },
        ];
      };
      company_invitations: {
        Row: {
          accepted_at: string | null;
          accepted_by: string | null;
          company_id: string;
          created_at: string;
          email: string;
          expires_at: string;
          id: string;
          invited_by: string | null;
          resend_count: number;
          revoked_at: string | null;
          revoked_by: string | null;
          role: string;
          status: string;
          token_hash: string;
          updated_at: string;
        };
        Insert: {
          accepted_at?: string | null;
          accepted_by?: string | null;
          company_id: string;
          created_at?: string;
          email: string;
          expires_at: string;
          id?: string;
          invited_by?: string | null;
          resend_count?: number;
          revoked_at?: string | null;
          revoked_by?: string | null;
          role: string;
          status?: string;
          token_hash: string;
          updated_at?: string;
        };
        Update: {
          accepted_at?: string | null;
          accepted_by?: string | null;
          company_id?: string;
          created_at?: string;
          email?: string;
          expires_at?: string;
          id?: string;
          invited_by?: string | null;
          resend_count?: number;
          revoked_at?: string | null;
          revoked_by?: string | null;
          role?: string;
          status?: string;
          token_hash?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "company_invitations_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "admin_company_stats";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "company_invitations_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "companies";
            referencedColumns: ["id"];
          },
        ];
      };
      company_members: {
        Row: {
          company_id: string;
          created_at: string;
          deactivated_at: string | null;
          deactivated_by: string | null;
          id: string;
          last_active_at: string | null;
          role: string;
          scope: string;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          company_id: string;
          created_at?: string;
          deactivated_at?: string | null;
          deactivated_by?: string | null;
          id?: string;
          last_active_at?: string | null;
          role: string;
          scope?: string;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          company_id?: string;
          created_at?: string;
          deactivated_at?: string | null;
          deactivated_by?: string | null;
          id?: string;
          last_active_at?: string | null;
          role?: string;
          scope?: string;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "company_members_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "admin_company_stats";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "company_members_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "companies";
            referencedColumns: ["id"];
          },
        ];
      };
      compliance_queue_items: {
        Row: {
          company_id: string;
          created_at: string;
          document_id: string | null;
          document_label: string;
          id: string;
          resolution: string | null;
          resolution_note: string;
          resolved_at: string | null;
          state: string;
          submitted_on: string;
          updated_at: string;
          vendor_id: string;
        };
        Insert: {
          company_id: string;
          created_at?: string;
          document_id?: string | null;
          document_label: string;
          id?: string;
          resolution?: string | null;
          resolution_note?: string;
          resolved_at?: string | null;
          state?: string;
          submitted_on?: string;
          updated_at?: string;
          vendor_id: string;
        };
        Update: {
          company_id?: string;
          created_at?: string;
          document_id?: string | null;
          document_label?: string;
          id?: string;
          resolution?: string | null;
          resolution_note?: string;
          resolved_at?: string | null;
          state?: string;
          submitted_on?: string;
          updated_at?: string;
          vendor_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "compliance_queue_items_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "admin_company_stats";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "compliance_queue_items_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "companies";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "compliance_queue_items_document_id_fkey";
            columns: ["document_id"];
            isOneToOne: false;
            referencedRelation: "documents_due_for_retry";
            referencedColumns: ["document_id"];
          },
          {
            foreignKeyName: "compliance_queue_items_document_id_fkey";
            columns: ["document_id"];
            isOneToOne: false;
            referencedRelation: "vendor_documents";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "compliance_queue_items_vendor_id_fkey";
            columns: ["vendor_id"];
            isOneToOne: false;
            referencedRelation: "vendor_compliance_summary";
            referencedColumns: ["vendor_id"];
          },
          {
            foreignKeyName: "compliance_queue_items_vendor_id_fkey";
            columns: ["vendor_id"];
            isOneToOne: false;
            referencedRelation: "vendors";
            referencedColumns: ["id"];
          },
        ];
      };
      compliance_requirements: {
        Row: {
          company_id: string;
          created_at: string;
          id: string;
          label: string;
          limit_field: string;
          policy_type: string;
          required_amount: number;
          sort_order: number;
          updated_at: string;
        };
        Insert: {
          company_id: string;
          created_at?: string;
          id?: string;
          label: string;
          limit_field: string;
          policy_type: string;
          required_amount: number;
          sort_order?: number;
          updated_at?: string;
        };
        Update: {
          company_id?: string;
          created_at?: string;
          id?: string;
          label?: string;
          limit_field?: string;
          policy_type?: string;
          required_amount?: number;
          sort_order?: number;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "compliance_requirements_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "admin_company_stats";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "compliance_requirements_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "companies";
            referencedColumns: ["id"];
          },
        ];
      };
      contact_submissions: {
        Row: {
          company: string | null;
          created_at: string | null;
          email: string;
          id: string;
          message: string | null;
          name: string | null;
          vendor_count: string | null;
        };
        Insert: {
          company?: string | null;
          created_at?: string | null;
          email: string;
          id?: string;
          message?: string | null;
          name?: string | null;
          vendor_count?: string | null;
        };
        Update: {
          company?: string | null;
          created_at?: string | null;
          email?: string;
          id?: string;
          message?: string | null;
          name?: string | null;
          vendor_count?: string | null;
        };
        Relationships: [];
      };
      contacts: {
        Row: {
          company_id: string;
          created_at: string;
          email: string;
          id: string;
          name: string;
          notes: string;
          phone: string;
          updated_at: string;
        };
        Insert: {
          company_id: string;
          created_at?: string;
          email: string;
          id?: string;
          name: string;
          notes?: string;
          phone?: string;
          updated_at?: string;
        };
        Update: {
          company_id?: string;
          created_at?: string;
          email?: string;
          id?: string;
          name?: string;
          notes?: string;
          phone?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "contacts_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "admin_company_stats";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "contacts_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "companies";
            referencedColumns: ["id"];
          },
        ];
      };
      email_delivery_events: {
        Row: {
          company_id: string;
          created_at: string;
          detail: Json;
          email_outbox_id: string;
          event_type: string;
          id: string;
          occurred_at: string;
        };
        Insert: {
          company_id: string;
          created_at?: string;
          detail?: Json;
          email_outbox_id: string;
          event_type: string;
          id?: string;
          occurred_at: string;
        };
        Update: {
          company_id?: string;
          created_at?: string;
          detail?: Json;
          email_outbox_id?: string;
          event_type?: string;
          id?: string;
          occurred_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "email_delivery_events_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "admin_company_stats";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "email_delivery_events_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "companies";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "email_delivery_events_email_outbox_id_fkey";
            columns: ["email_outbox_id"];
            isOneToOne: false;
            referencedRelation: "email_outbox";
            referencedColumns: ["id"];
          },
        ];
      };
      email_outbox: {
        Row: {
          company_id: string;
          created_at: string;
          error: string | null;
          id: string;
          provider_message_id: string | null;
          sent_at: string | null;
          status: string;
          template: string;
          to_email: string;
          upload_request_id: string | null;
          vendor_id: string;
        };
        Insert: {
          company_id: string;
          created_at?: string;
          error?: string | null;
          id?: string;
          provider_message_id?: string | null;
          sent_at?: string | null;
          status?: string;
          template: string;
          to_email: string;
          upload_request_id?: string | null;
          vendor_id: string;
        };
        Update: {
          company_id?: string;
          created_at?: string;
          error?: string | null;
          id?: string;
          provider_message_id?: string | null;
          sent_at?: string | null;
          status?: string;
          template?: string;
          to_email?: string;
          upload_request_id?: string | null;
          vendor_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "email_outbox_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "admin_company_stats";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "email_outbox_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "companies";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "email_outbox_upload_request_id_fkey";
            columns: ["upload_request_id"];
            isOneToOne: false;
            referencedRelation: "vendor_upload_requests";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "email_outbox_vendor_id_fkey";
            columns: ["vendor_id"];
            isOneToOne: false;
            referencedRelation: "vendor_compliance_summary";
            referencedColumns: ["vendor_id"];
          },
          {
            foreignKeyName: "email_outbox_vendor_id_fkey";
            columns: ["vendor_id"];
            isOneToOne: false;
            referencedRelation: "vendors";
            referencedColumns: ["id"];
          },
        ];
      };
      leads: {
        Row: {
          company_name: string;
          contact_name: string;
          created_at: string;
          created_on: string;
          id: string;
          source: string;
          stage: string;
          trade: string;
          updated_at: string;
        };
        Insert: {
          company_name: string;
          contact_name?: string;
          created_at?: string;
          created_on?: string;
          id?: string;
          source?: string;
          stage?: string;
          trade?: string;
          updated_at?: string;
        };
        Update: {
          company_name?: string;
          contact_name?: string;
          created_at?: string;
          created_on?: string;
          id?: string;
          source?: string;
          stage?: string;
          trade?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      platform_admins: {
        Row: {
          created_at: string;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          user_id: string;
        };
        Update: {
          created_at?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      policy_reminder_log: {
        Row: {
          company_id: string;
          days_threshold: number;
          id: string;
          policy_id: string;
          sent_at: string;
          vendor_id: string;
        };
        Insert: {
          company_id: string;
          days_threshold: number;
          id?: string;
          policy_id: string;
          sent_at?: string;
          vendor_id: string;
        };
        Update: {
          company_id?: string;
          days_threshold?: number;
          id?: string;
          policy_id?: string;
          sent_at?: string;
          vendor_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "policy_reminder_log_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "admin_company_stats";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "policy_reminder_log_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "companies";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "policy_reminder_log_policy_id_fkey";
            columns: ["policy_id"];
            isOneToOne: false;
            referencedRelation: "policies_due_for_reminder";
            referencedColumns: ["policy_id"];
          },
          {
            foreignKeyName: "policy_reminder_log_policy_id_fkey";
            columns: ["policy_id"];
            isOneToOne: false;
            referencedRelation: "vendor_policies";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "policy_reminder_log_vendor_id_fkey";
            columns: ["vendor_id"];
            isOneToOne: false;
            referencedRelation: "vendor_compliance_summary";
            referencedColumns: ["vendor_id"];
          },
          {
            foreignKeyName: "policy_reminder_log_vendor_id_fkey";
            columns: ["vendor_id"];
            isOneToOne: false;
            referencedRelation: "vendors";
            referencedColumns: ["id"];
          },
        ];
      };
      profiles: {
        Row: {
          created_at: string;
          email: string;
          full_name: string | null;
          id: string;
          updated_at: string;
        };
        Insert: {
          created_at?: string;
          email: string;
          full_name?: string | null;
          id: string;
          updated_at?: string;
        };
        Update: {
          created_at?: string;
          email?: string;
          full_name?: string | null;
          id?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      project_requirement_overrides: {
        Row: {
          company_id: string;
          created_at: string;
          id: string;
          project_id: string;
          rule_key: string;
          updated_at: string;
          value: Json;
        };
        Insert: {
          company_id: string;
          created_at?: string;
          id?: string;
          project_id: string;
          rule_key: string;
          updated_at?: string;
          value?: Json;
        };
        Update: {
          company_id?: string;
          created_at?: string;
          id?: string;
          project_id?: string;
          rule_key?: string;
          updated_at?: string;
          value?: Json;
        };
        Relationships: [
          {
            foreignKeyName: "project_requirement_overrides_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "admin_company_stats";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "project_requirement_overrides_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "companies";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "project_requirement_overrides_project_id_fkey";
            columns: ["project_id"];
            isOneToOne: false;
            referencedRelation: "projects";
            referencedColumns: ["id"];
          },
        ];
      };
      project_vendor_assignments: {
        Row: {
          company_id: string;
          contract_number: string | null;
          contract_value: number | null;
          created_at: string;
          end_date: string | null;
          id: string;
          project_id: string;
          requirement_profile_id: string | null;
          risk_classification: string | null;
          start_date: string | null;
          status: string;
          trade_code: string | null;
          updated_at: string;
          vendor_id: string;
        };
        Insert: {
          company_id: string;
          contract_number?: string | null;
          contract_value?: number | null;
          created_at?: string;
          end_date?: string | null;
          id?: string;
          project_id: string;
          requirement_profile_id?: string | null;
          risk_classification?: string | null;
          start_date?: string | null;
          status?: string;
          trade_code?: string | null;
          updated_at?: string;
          vendor_id: string;
        };
        Update: {
          company_id?: string;
          contract_number?: string | null;
          contract_value?: number | null;
          created_at?: string;
          end_date?: string | null;
          id?: string;
          project_id?: string;
          requirement_profile_id?: string | null;
          risk_classification?: string | null;
          start_date?: string | null;
          status?: string;
          trade_code?: string | null;
          updated_at?: string;
          vendor_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "project_vendor_assignments_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "admin_company_stats";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "project_vendor_assignments_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "companies";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "project_vendor_assignments_project_id_fkey";
            columns: ["project_id"];
            isOneToOne: false;
            referencedRelation: "projects";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "project_vendor_assignments_requirement_profile_id_fkey";
            columns: ["requirement_profile_id"];
            isOneToOne: false;
            referencedRelation: "requirement_profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "project_vendor_assignments_vendor_id_fkey";
            columns: ["vendor_id"];
            isOneToOne: false;
            referencedRelation: "vendor_compliance_summary";
            referencedColumns: ["vendor_id"];
          },
          {
            foreignKeyName: "project_vendor_assignments_vendor_id_fkey";
            columns: ["vendor_id"];
            isOneToOne: false;
            referencedRelation: "vendors";
            referencedColumns: ["id"];
          },
        ];
      };
      projects: {
        Row: {
          certificate_holder_address: string;
          certificate_holder_name: string;
          company_id: string;
          created_at: string;
          default_requirement_profile_id: string | null;
          id: string;
          name: string;
          project_number: string | null;
          status: string;
          updated_at: string;
        };
        Insert: {
          certificate_holder_address?: string;
          certificate_holder_name?: string;
          company_id: string;
          created_at?: string;
          default_requirement_profile_id?: string | null;
          id?: string;
          name: string;
          project_number?: string | null;
          status?: string;
          updated_at?: string;
        };
        Update: {
          certificate_holder_address?: string;
          certificate_holder_name?: string;
          company_id?: string;
          created_at?: string;
          default_requirement_profile_id?: string | null;
          id?: string;
          name?: string;
          project_number?: string | null;
          status?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "projects_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "admin_company_stats";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "projects_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "companies";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "projects_default_requirement_profile_id_fkey";
            columns: ["default_requirement_profile_id"];
            isOneToOne: false;
            referencedRelation: "requirement_profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      requirement_profile_rules: {
        Row: {
          amount: number | null;
          company_id: string;
          configuration: Json;
          created_at: string;
          id: string;
          policy_type: string | null;
          profile_id: string;
          required: boolean;
          rule_key: string;
          rule_kind: string;
          updated_at: string;
        };
        Insert: {
          amount?: number | null;
          company_id: string;
          configuration?: Json;
          created_at?: string;
          id?: string;
          policy_type?: string | null;
          profile_id: string;
          required?: boolean;
          rule_key: string;
          rule_kind: string;
          updated_at?: string;
        };
        Update: {
          amount?: number | null;
          company_id?: string;
          configuration?: Json;
          created_at?: string;
          id?: string;
          policy_type?: string | null;
          profile_id?: string;
          required?: boolean;
          rule_key?: string;
          rule_kind?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "requirement_profile_rules_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "admin_company_stats";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "requirement_profile_rules_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "companies";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "requirement_profile_rules_profile_id_fkey";
            columns: ["profile_id"];
            isOneToOne: false;
            referencedRelation: "requirement_profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      requirement_profiles: {
        Row: {
          company_id: string;
          created_at: string;
          id: string;
          is_company_default: boolean;
          name: string;
          updated_at: string;
        };
        Insert: {
          company_id: string;
          created_at?: string;
          id?: string;
          is_company_default?: boolean;
          name: string;
          updated_at?: string;
        };
        Update: {
          company_id?: string;
          created_at?: string;
          id?: string;
          is_company_default?: boolean;
          name?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "requirement_profiles_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "admin_company_stats";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "requirement_profiles_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "companies";
            referencedColumns: ["id"];
          },
        ];
      };
      signup_invites: {
        Row: {
          code: string;
          company_name: string;
          created_at: string;
          created_by: string | null;
          email: string;
          expires_at: string;
          id: string;
          status: string;
          updated_at: string;
          used_at: string | null;
          used_by: string | null;
        };
        Insert: {
          code: string;
          company_name: string;
          created_at?: string;
          created_by?: string | null;
          email: string;
          expires_at: string;
          id?: string;
          status?: string;
          updated_at?: string;
          used_at?: string | null;
          used_by?: string | null;
        };
        Update: {
          code?: string;
          company_name?: string;
          created_at?: string;
          created_by?: string | null;
          email?: string;
          expires_at?: string;
          id?: string;
          status?: string;
          updated_at?: string;
          used_at?: string | null;
          used_by?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "signup_invites_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "platform_admins";
            referencedColumns: ["user_id"];
          },
        ];
      };
      suppressed_recipients: {
        Row: {
          company_id: string;
          created_at: string;
          email: string;
          id: string;
          reason: string;
          source_event_id: string | null;
          suppressed_at: string;
          updated_at: string;
        };
        Insert: {
          company_id: string;
          created_at?: string;
          email: string;
          id?: string;
          reason: string;
          source_event_id?: string | null;
          suppressed_at?: string;
          updated_at?: string;
        };
        Update: {
          company_id?: string;
          created_at?: string;
          email?: string;
          id?: string;
          reason?: string;
          source_event_id?: string | null;
          suppressed_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "suppressed_recipients_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "admin_company_stats";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "suppressed_recipients_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "companies";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "suppressed_recipients_source_event_id_fkey";
            columns: ["source_event_id"];
            isOneToOne: false;
            referencedRelation: "email_delivery_events";
            referencedColumns: ["id"];
          },
        ];
      };
      tasks: {
        Row: {
          company_id: string;
          created_at: string;
          due_on: string | null;
          id: string;
          owner: string;
          priority: string;
          status: string;
          title: string;
          updated_at: string;
          vendor_id: string | null;
        };
        Insert: {
          company_id: string;
          created_at?: string;
          due_on?: string | null;
          id?: string;
          owner?: string;
          priority?: string;
          status?: string;
          title: string;
          updated_at?: string;
          vendor_id?: string | null;
        };
        Update: {
          company_id?: string;
          created_at?: string;
          due_on?: string | null;
          id?: string;
          owner?: string;
          priority?: string;
          status?: string;
          title?: string;
          updated_at?: string;
          vendor_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "tasks_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "admin_company_stats";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "tasks_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "companies";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "tasks_vendor_id_fkey";
            columns: ["vendor_id"];
            isOneToOne: false;
            referencedRelation: "vendor_compliance_summary";
            referencedColumns: ["vendor_id"];
          },
          {
            foreignKeyName: "tasks_vendor_id_fkey";
            columns: ["vendor_id"];
            isOneToOne: false;
            referencedRelation: "vendors";
            referencedColumns: ["id"];
          },
        ];
      };
      upload_rate_limit_counters: {
        Row: {
          bucket_key: string;
          count: number;
          window_start: string;
        };
        Insert: {
          bucket_key: string;
          count?: number;
          window_start: string;
        };
        Update: {
          bucket_key?: string;
          count?: number;
          window_start?: string;
        };
        Relationships: [];
      };
      vendor_compliance_items: {
        Row: {
          company_id: string;
          created_at: string;
          effective_date: string | null;
          id: string;
          note: string | null;
          requirement_key: string;
          status: string;
          updated_at: string;
          vendor_id: string;
        };
        Insert: {
          company_id: string;
          created_at?: string;
          effective_date?: string | null;
          id?: string;
          note?: string | null;
          requirement_key: string;
          status?: string;
          updated_at?: string;
          vendor_id: string;
        };
        Update: {
          company_id?: string;
          created_at?: string;
          effective_date?: string | null;
          id?: string;
          note?: string | null;
          requirement_key?: string;
          status?: string;
          updated_at?: string;
          vendor_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "vendor_compliance_items_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "admin_company_stats";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "vendor_compliance_items_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "companies";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "vendor_compliance_items_vendor_id_fkey";
            columns: ["vendor_id"];
            isOneToOne: false;
            referencedRelation: "vendor_compliance_summary";
            referencedColumns: ["vendor_id"];
          },
          {
            foreignKeyName: "vendor_compliance_items_vendor_id_fkey";
            columns: ["vendor_id"];
            isOneToOne: false;
            referencedRelation: "vendors";
            referencedColumns: ["id"];
          },
        ];
      };
      vendor_contacts: {
        Row: {
          company_id: string;
          contact_id: string;
          created_at: string;
          id: string;
          role: string;
          vendor_id: string;
        };
        Insert: {
          company_id: string;
          contact_id: string;
          created_at?: string;
          id?: string;
          role: string;
          vendor_id: string;
        };
        Update: {
          company_id?: string;
          contact_id?: string;
          created_at?: string;
          id?: string;
          role?: string;
          vendor_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "vendor_contacts_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "admin_company_stats";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "vendor_contacts_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "companies";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "vendor_contacts_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "contacts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "vendor_contacts_vendor_id_fkey";
            columns: ["vendor_id"];
            isOneToOne: false;
            referencedRelation: "vendor_compliance_summary";
            referencedColumns: ["vendor_id"];
          },
          {
            foreignKeyName: "vendor_contacts_vendor_id_fkey";
            columns: ["vendor_id"];
            isOneToOne: false;
            referencedRelation: "vendors";
            referencedColumns: ["id"];
          },
        ];
      };
      vendor_documents: {
        Row: {
          applied_policy_id: string | null;
          company_id: string;
          created_at: string;
          duplicate_of_document_id: string | null;
          extraction_confidence: number | null;
          file_name: string;
          file_size: number;
          id: string;
          malware_scan_detail: string | null;
          malware_scan_status: string;
          mime_type: string;
          next_retry_at: string | null;
          parsed_data: Json | null;
          processed_at: string | null;
          processing_error: string | null;
          processing_status: string;
          retry_count: number;
          review_reason: string | null;
          scanned_at: string | null;
          sha256: string;
          source: string;
          storage_path: string;
          updated_at: string;
          upload_request_id: string | null;
          uploaded_at: string;
          vendor_id: string;
        };
        Insert: {
          applied_policy_id?: string | null;
          company_id: string;
          created_at?: string;
          duplicate_of_document_id?: string | null;
          extraction_confidence?: number | null;
          file_name: string;
          file_size: number;
          id?: string;
          malware_scan_detail?: string | null;
          malware_scan_status?: string;
          mime_type: string;
          next_retry_at?: string | null;
          parsed_data?: Json | null;
          processed_at?: string | null;
          processing_error?: string | null;
          processing_status?: string;
          retry_count?: number;
          review_reason?: string | null;
          scanned_at?: string | null;
          sha256: string;
          source?: string;
          storage_path: string;
          updated_at?: string;
          upload_request_id?: string | null;
          uploaded_at?: string;
          vendor_id: string;
        };
        Update: {
          applied_policy_id?: string | null;
          company_id?: string;
          created_at?: string;
          duplicate_of_document_id?: string | null;
          extraction_confidence?: number | null;
          file_name?: string;
          file_size?: number;
          id?: string;
          malware_scan_detail?: string | null;
          malware_scan_status?: string;
          mime_type?: string;
          next_retry_at?: string | null;
          parsed_data?: Json | null;
          processed_at?: string | null;
          processing_error?: string | null;
          processing_status?: string;
          retry_count?: number;
          review_reason?: string | null;
          scanned_at?: string | null;
          sha256?: string;
          source?: string;
          storage_path?: string;
          updated_at?: string;
          upload_request_id?: string | null;
          uploaded_at?: string;
          vendor_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "vendor_documents_applied_policy_id_fkey";
            columns: ["applied_policy_id"];
            isOneToOne: false;
            referencedRelation: "policies_due_for_reminder";
            referencedColumns: ["policy_id"];
          },
          {
            foreignKeyName: "vendor_documents_applied_policy_id_fkey";
            columns: ["applied_policy_id"];
            isOneToOne: false;
            referencedRelation: "vendor_policies";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "vendor_documents_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "admin_company_stats";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "vendor_documents_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "companies";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "vendor_documents_duplicate_of_document_id_fkey";
            columns: ["duplicate_of_document_id"];
            isOneToOne: false;
            referencedRelation: "documents_due_for_retry";
            referencedColumns: ["document_id"];
          },
          {
            foreignKeyName: "vendor_documents_duplicate_of_document_id_fkey";
            columns: ["duplicate_of_document_id"];
            isOneToOne: false;
            referencedRelation: "vendor_documents";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "vendor_documents_upload_request_id_fkey";
            columns: ["upload_request_id"];
            isOneToOne: false;
            referencedRelation: "vendor_upload_requests";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "vendor_documents_vendor_id_fkey";
            columns: ["vendor_id"];
            isOneToOne: false;
            referencedRelation: "vendor_compliance_summary";
            referencedColumns: ["vendor_id"];
          },
          {
            foreignKeyName: "vendor_documents_vendor_id_fkey";
            columns: ["vendor_id"];
            isOneToOne: false;
            referencedRelation: "vendors";
            referencedColumns: ["id"];
          },
        ];
      };
      vendor_policies: {
        Row: {
          additional_insured: boolean | null;
          carrier_name: string;
          certificate_holder_address: string | null;
          certificate_holder_name: string | null;
          company_id: string;
          created_at: string;
          each_occurrence_limit: number | null;
          effective_date: string | null;
          expiration_date: string | null;
          general_aggregate_limit: number | null;
          id: string;
          policy_number: string;
          policy_type: string;
          primary_noncontributory: boolean | null;
          status: string;
          updated_at: string;
          vendor_id: string;
          verification_status: string;
          waiver_of_subrogation: boolean | null;
        };
        Insert: {
          additional_insured?: boolean | null;
          carrier_name?: string;
          certificate_holder_address?: string | null;
          certificate_holder_name?: string | null;
          company_id: string;
          created_at?: string;
          each_occurrence_limit?: number | null;
          effective_date?: string | null;
          expiration_date?: string | null;
          general_aggregate_limit?: number | null;
          id?: string;
          policy_number?: string;
          policy_type: string;
          primary_noncontributory?: boolean | null;
          status?: string;
          updated_at?: string;
          vendor_id: string;
          verification_status?: string;
          waiver_of_subrogation?: boolean | null;
        };
        Update: {
          additional_insured?: boolean | null;
          carrier_name?: string;
          certificate_holder_address?: string | null;
          certificate_holder_name?: string | null;
          company_id?: string;
          created_at?: string;
          each_occurrence_limit?: number | null;
          effective_date?: string | null;
          expiration_date?: string | null;
          general_aggregate_limit?: number | null;
          id?: string;
          policy_number?: string;
          policy_type?: string;
          primary_noncontributory?: boolean | null;
          status?: string;
          updated_at?: string;
          vendor_id?: string;
          verification_status?: string;
          waiver_of_subrogation?: boolean | null;
        };
        Relationships: [
          {
            foreignKeyName: "vendor_policies_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "admin_company_stats";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "vendor_policies_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "companies";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "vendor_policies_vendor_id_fkey";
            columns: ["vendor_id"];
            isOneToOne: false;
            referencedRelation: "vendor_compliance_summary";
            referencedColumns: ["vendor_id"];
          },
          {
            foreignKeyName: "vendor_policies_vendor_id_fkey";
            columns: ["vendor_id"];
            isOneToOne: false;
            referencedRelation: "vendors";
            referencedColumns: ["id"];
          },
        ];
      };
      vendor_upload_requests: {
        Row: {
          company_id: string;
          completed_at: string | null;
          created_at: string;
          created_by: string | null;
          expires_at: string;
          id: string;
          opened_at: string | null;
          purpose: string;
          status: string;
          token_hash: string;
          updated_at: string;
          uploaded_at: string | null;
          vendor_id: string;
        };
        Insert: {
          company_id: string;
          completed_at?: string | null;
          created_at?: string;
          created_by?: string | null;
          expires_at: string;
          id?: string;
          opened_at?: string | null;
          purpose?: string;
          status?: string;
          token_hash: string;
          updated_at?: string;
          uploaded_at?: string | null;
          vendor_id: string;
        };
        Update: {
          company_id?: string;
          completed_at?: string | null;
          created_at?: string;
          created_by?: string | null;
          expires_at?: string;
          id?: string;
          opened_at?: string | null;
          purpose?: string;
          status?: string;
          token_hash?: string;
          updated_at?: string;
          uploaded_at?: string | null;
          vendor_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "vendor_upload_requests_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "admin_company_stats";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "vendor_upload_requests_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "companies";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "vendor_upload_requests_vendor_id_fkey";
            columns: ["vendor_id"];
            isOneToOne: false;
            referencedRelation: "vendor_compliance_summary";
            referencedColumns: ["vendor_id"];
          },
          {
            foreignKeyName: "vendor_upload_requests_vendor_id_fkey";
            columns: ["vendor_id"];
            isOneToOne: false;
            referencedRelation: "vendors";
            referencedColumns: ["id"];
          },
        ];
      };
      vendors: {
        Row: {
          archived_at: string | null;
          company_id: string;
          contact_email: string;
          contact_name: string;
          contract_value: number;
          created_at: string;
          id: string;
          name: string;
          project: string;
          risk_tier: string;
          trade: string;
          updated_at: string;
        };
        Insert: {
          archived_at?: string | null;
          company_id: string;
          contact_email?: string;
          contact_name?: string;
          contract_value?: number;
          created_at?: string;
          id?: string;
          name: string;
          project?: string;
          risk_tier?: string;
          trade: string;
          updated_at?: string;
        };
        Update: {
          archived_at?: string | null;
          company_id?: string;
          contact_email?: string;
          contact_name?: string;
          contract_value?: number;
          created_at?: string;
          id?: string;
          name?: string;
          project?: string;
          risk_tier?: string;
          trade?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "vendors_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "admin_company_stats";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "vendors_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "companies";
            referencedColumns: ["id"];
          },
        ];
      };
    };
    Views: {
      admin_company_stats: {
        Row: {
          compliance_rate: number | null;
          id: string | null;
          name: string | null;
          plan: string | null;
          seat_count: number | null;
          subscription_renews_on: string | null;
          vendor_count: number | null;
        };
        Insert: {
          compliance_rate?: never;
          id?: string | null;
          name?: string | null;
          plan?: string | null;
          seat_count?: never;
          subscription_renews_on?: string | null;
          vendor_count?: never;
        };
        Update: {
          compliance_rate?: never;
          id?: string | null;
          name?: string | null;
          plan?: string | null;
          seat_count?: never;
          subscription_renews_on?: string | null;
          vendor_count?: never;
        };
        Relationships: [];
      };
      company_report_rows: {
        Row: {
          company_id: string | null;
          compliant_pct: number | null;
          expiring_in_30: number | null;
          id: string | null;
          open_exceptions: number | null;
          project: string | null;
          vendors: number | null;
        };
        Relationships: [
          {
            foreignKeyName: "vendors_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "admin_company_stats";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "vendors_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "companies";
            referencedColumns: ["id"];
          },
        ];
      };
      documents_due_for_retry: {
        Row: {
          company_id: string | null;
          document_id: string | null;
          file_name: string | null;
          mime_type: string | null;
          retry_count: number | null;
          storage_path: string | null;
          vendor_id: string | null;
        };
        Insert: {
          company_id?: string | null;
          document_id?: string | null;
          file_name?: string | null;
          mime_type?: string | null;
          retry_count?: number | null;
          storage_path?: string | null;
          vendor_id?: string | null;
        };
        Update: {
          company_id?: string | null;
          document_id?: string | null;
          file_name?: string | null;
          mime_type?: string | null;
          retry_count?: number | null;
          storage_path?: string | null;
          vendor_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "vendor_documents_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "admin_company_stats";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "vendor_documents_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "companies";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "vendor_documents_vendor_id_fkey";
            columns: ["vendor_id"];
            isOneToOne: false;
            referencedRelation: "vendor_compliance_summary";
            referencedColumns: ["vendor_id"];
          },
          {
            foreignKeyName: "vendor_documents_vendor_id_fkey";
            columns: ["vendor_id"];
            isOneToOne: false;
            referencedRelation: "vendors";
            referencedColumns: ["id"];
          },
        ];
      };
      policies_due_for_reminder: {
        Row: {
          company_id: string | null;
          days_threshold: number | null;
          expiration_date: string | null;
          policy_id: string | null;
          vendor_id: string | null;
        };
        Insert: {
          company_id?: string | null;
          days_threshold?: never;
          expiration_date?: string | null;
          policy_id?: string | null;
          vendor_id?: string | null;
        };
        Update: {
          company_id?: string | null;
          days_threshold?: never;
          expiration_date?: string | null;
          policy_id?: string | null;
          vendor_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "vendor_policies_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "admin_company_stats";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "vendor_policies_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "companies";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "vendor_policies_vendor_id_fkey";
            columns: ["vendor_id"];
            isOneToOne: false;
            referencedRelation: "vendor_compliance_summary";
            referencedColumns: ["vendor_id"];
          },
          {
            foreignKeyName: "vendor_policies_vendor_id_fkey";
            columns: ["vendor_id"];
            isOneToOne: false;
            referencedRelation: "vendors";
            referencedColumns: ["id"];
          },
        ];
      };
      vendor_compliance_summary: {
        Row: {
          company_id: string | null;
          fully_compliant: boolean | null;
          next_expiration: string | null;
          open_exceptions: number | null;
          project: string | null;
          vendor_id: string | null;
        };
        Insert: {
          company_id?: string | null;
          fully_compliant?: never;
          next_expiration?: never;
          open_exceptions?: never;
          project?: string | null;
          vendor_id?: string | null;
        };
        Update: {
          company_id?: string | null;
          fully_compliant?: never;
          next_expiration?: never;
          open_exceptions?: never;
          project?: string | null;
          vendor_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "vendors_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "admin_company_stats";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "vendors_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "companies";
            referencedColumns: ["id"];
          },
        ];
      };
    };
    Functions: {
      accept_company_invitation: {
        Args: { p_token_hash: string };
        Returns: Json;
      };
      apply_policy_renewal: {
        Args: {
          p_additional_insured: boolean;
          p_carrier_name: string;
          p_certificate_holder_address: string;
          p_certificate_holder_name: string;
          p_company_id: string;
          p_each_occurrence_limit: number;
          p_effective_date: string;
          p_existing_policy_id: string;
          p_expiration_date: string;
          p_general_aggregate_limit: number;
          p_policy_number: string;
          p_policy_type: string;
          p_vendor_id: string;
          p_waiver_of_subrogation: boolean;
        };
        Returns: string;
      };
      can_write_company: { Args: { target_company: string }; Returns: boolean };
      change_company_member_role: {
        Args: { new_role: string; target_member_id: string };
        Returns: {
          company_id: string;
          created_at: string;
          deactivated_at: string | null;
          deactivated_by: string | null;
          id: string;
          last_active_at: string | null;
          role: string;
          scope: string;
          updated_at: string;
          user_id: string;
        };
        SetofOptions: {
          from: "*";
          to: "company_members";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      create_company_for_current_user: {
        Args: { company_name: string; member_name?: string };
        Returns: string;
      };
      create_company_invitation: {
        Args: {
          invitee_email: string;
          invitee_role: string;
          p_expires_at: string;
          p_token_hash: string;
          target_company: string;
        };
        Returns: {
          accepted_at: string | null;
          accepted_by: string | null;
          company_id: string;
          created_at: string;
          email: string;
          expires_at: string;
          id: string;
          invited_by: string | null;
          resend_count: number;
          revoked_at: string | null;
          revoked_by: string | null;
          role: string;
          status: string;
          token_hash: string;
          updated_at: string;
        };
        SetofOptions: {
          from: "*";
          to: "company_invitations";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      create_signup_invite: {
        Args: { company_name: string; email: string };
        Returns: {
          code: string;
          company_name: string;
          created_at: string;
          created_by: string | null;
          email: string;
          expires_at: string;
          id: string;
          status: string;
          updated_at: string;
          used_at: string | null;
          used_by: string | null;
        };
        SetofOptions: {
          from: "*";
          to: "signup_invites";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      current_company_ids: { Args: never; Returns: string[] };
      current_reminder_threshold: {
        Args: { days_until: number };
        Returns: number;
      };
      current_user_id: { Args: never; Returns: string };
      get_database_size_bytes: { Args: never; Returns: number };
      get_scheduled_job_run_history: {
        Args: never;
        Returns: {
          job_name: string;
          start_time: string;
          status: string;
        }[];
      };
      has_company_role: {
        Args: { allowed: string[]; target_company: string };
        Returns: boolean;
      };
      increment_upload_rate_limit_counter: {
        Args: { p_bucket_key: string; p_window_start: string };
        Returns: number;
      };
      is_platform_admin: { Args: never; Returns: boolean };
      remove_company_member: {
        Args: { target_member_id: string };
        Returns: {
          company_id: string;
          created_at: string;
          deactivated_at: string | null;
          deactivated_by: string | null;
          id: string;
          last_active_at: string | null;
          role: string;
          scope: string;
          updated_at: string;
          user_id: string;
        };
        SetofOptions: {
          from: "*";
          to: "company_members";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      resend_company_invitation: {
        Args: {
          invitation_id: string;
          p_expires_at: string;
          p_token_hash: string;
        };
        Returns: {
          accepted_at: string | null;
          accepted_by: string | null;
          company_id: string;
          created_at: string;
          email: string;
          expires_at: string;
          id: string;
          invited_by: string | null;
          resend_count: number;
          revoked_at: string | null;
          revoked_by: string | null;
          role: string;
          status: string;
          token_hash: string;
          updated_at: string;
        };
        SetofOptions: {
          from: "*";
          to: "company_invitations";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      resolve_assignment_requirements: {
        Args: { assignment_id: string };
        Returns: {
          amount: number;
          key: string;
          kind: string;
          policy_type: string;
          required: boolean;
          source: string;
        }[];
      };
      revoke_company_invitation: {
        Args: { invitation_id: string };
        Returns: {
          accepted_at: string | null;
          accepted_by: string | null;
          company_id: string;
          created_at: string;
          email: string;
          expires_at: string;
          id: string;
          invited_by: string | null;
          resend_count: number;
          revoked_at: string | null;
          revoked_by: string | null;
          role: string;
          status: string;
          token_hash: string;
          updated_at: string;
        };
        SetofOptions: {
          from: "*";
          to: "company_invitations";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      set_company_feature_flag: {
        Args: {
          flag_enabled: boolean;
          flag_key: string;
          target_company: string;
        };
        Returns: {
          company_id: string;
          enabled: boolean;
          key: string;
          updated_at: string;
        };
        SetofOptions: {
          from: "*";
          to: "company_feature_flags";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      shares_company_with: { Args: { target_user: string }; Returns: boolean };
      transfer_company_ownership: {
        Args: {
          demoted_role?: string;
          from_member_id: string;
          to_member_id: string;
        };
        Returns: {
          company_id: string;
          created_at: string;
          deactivated_at: string | null;
          deactivated_by: string | null;
          id: string;
          last_active_at: string | null;
          role: string;
          scope: string;
          updated_at: string;
          user_id: string;
        }[];
        SetofOptions: {
          from: "*";
          to: "company_members";
          isOneToOne: false;
          isSetofReturn: true;
        };
      };
    };
    Enums: {
      [_ in never]: never;
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">;

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">];

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R;
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] & DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R;
      }
      ? R
      : never
    : never;

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    keyof DefaultSchema["Tables"] | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I;
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I;
      }
      ? I
      : never
    : never;

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    keyof DefaultSchema["Tables"] | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U;
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U;
      }
      ? U
      : never
    : never;

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    keyof DefaultSchema["Enums"] | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never;

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    keyof DefaultSchema["CompositeTypes"] | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never;

export const Constants = {
  public: {
    Enums: {},
  },
} as const;
