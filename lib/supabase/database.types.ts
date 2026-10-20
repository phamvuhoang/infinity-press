export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      analytics_events: {
        Row: {
          book_id: string | null
          dedupe_key: string | null
          device_class: string | null
          event_name: string
          id: string
          locale: string | null
          occurred_at: string
          order_id: string | null
          processing_job_id: string | null
          profile_id: string | null
          publication_id: string | null
          retailer: string | null
          shared_quote_id: string | null
        }
        Insert: {
          book_id?: string | null
          dedupe_key?: string | null
          device_class?: string | null
          event_name: string
          id?: string
          locale?: string | null
          occurred_at?: string
          order_id?: string | null
          processing_job_id?: string | null
          profile_id?: string | null
          publication_id?: string | null
          retailer?: string | null
          shared_quote_id?: string | null
        }
        Update: {
          book_id?: string | null
          dedupe_key?: string | null
          device_class?: string | null
          event_name?: string
          id?: string
          locale?: string | null
          occurred_at?: string
          order_id?: string | null
          processing_job_id?: string | null
          profile_id?: string | null
          publication_id?: string | null
          retailer?: string | null
          shared_quote_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "analytics_events_book_id_fkey"
            columns: ["book_id"]
            isOneToOne: false
            referencedRelation: "books"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "analytics_events_locale_fkey"
            columns: ["locale"]
            isOneToOne: false
            referencedRelation: "supported_locales"
            referencedColumns: ["code"]
          },
          {
            foreignKeyName: "analytics_events_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "analytics_events_processing_job_id_fkey"
            columns: ["processing_job_id"]
            isOneToOne: false
            referencedRelation: "processing_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "analytics_events_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "analytics_events_publication_id_fkey"
            columns: ["publication_id"]
            isOneToOne: false
            referencedRelation: "ebook_publications"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "analytics_events_shared_quote_id_fkey"
            columns: ["shared_quote_id"]
            isOneToOne: false
            referencedRelation: "shared_quotes"
            referencedColumns: ["id"]
          },
        ]
      }
      analytics_intake_quota: {
        Row: {
          bucket_key: string
          event_count: number
          window_start: string
        }
        Insert: {
          bucket_key: string
          event_count: number
          window_start: string
        }
        Update: {
          bucket_key?: string
          event_count?: number
          window_start?: string
        }
        Relationships: []
      }
      article_books: {
        Row: {
          article_id: string
          book_id: string
          position: number
        }
        Insert: {
          article_id: string
          book_id: string
          position: number
        }
        Update: {
          article_id?: string
          book_id?: string
          position?: number
        }
        Relationships: [
          {
            foreignKeyName: "article_books_article_id_fkey"
            columns: ["article_id"]
            isOneToOne: false
            referencedRelation: "articles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "article_books_book_id_fkey"
            columns: ["book_id"]
            isOneToOne: false
            referencedRelation: "books"
            referencedColumns: ["id"]
          },
        ]
      }
      article_ideas: {
        Row: {
          article_id: string
          idea_id: string
          position: number
        }
        Insert: {
          article_id: string
          idea_id: string
          position: number
        }
        Update: {
          article_id?: string
          idea_id?: string
          position?: number
        }
        Relationships: [
          {
            foreignKeyName: "article_ideas_article_id_fkey"
            columns: ["article_id"]
            isOneToOne: false
            referencedRelation: "articles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "article_ideas_idea_id_fkey"
            columns: ["idea_id"]
            isOneToOne: false
            referencedRelation: "ideas"
            referencedColumns: ["id"]
          },
        ]
      }
      article_localizations: {
        Row: {
          article_id: string
          body_blocks: NonNullable<Json>
          excerpt: string
          id: string
          locale: string
          seo_description: string | null
          seo_title: string | null
          slug: string
          title: string
          updated_at: string
        }
        Insert: {
          article_id: string
          body_blocks?: NonNullable<Json>
          excerpt: string
          id?: string
          locale: string
          seo_description?: string | null
          seo_title?: string | null
          slug: string
          title: string
          updated_at?: string
        }
        Update: {
          article_id?: string
          body_blocks?: NonNullable<Json>
          excerpt?: string
          id?: string
          locale?: string
          seo_description?: string | null
          seo_title?: string | null
          slug?: string
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "article_localizations_article_id_fkey"
            columns: ["article_id"]
            isOneToOne: false
            referencedRelation: "articles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "article_localizations_locale_fkey"
            columns: ["locale"]
            isOneToOne: false
            referencedRelation: "supported_locales"
            referencedColumns: ["code"]
          },
        ]
      }
      article_topics: {
        Row: {
          article_id: string
          topic_id: string
        }
        Insert: {
          article_id: string
          topic_id: string
        }
        Update: {
          article_id?: string
          topic_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "article_topics_article_id_fkey"
            columns: ["article_id"]
            isOneToOne: false
            referencedRelation: "articles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "article_topics_topic_id_fkey"
            columns: ["topic_id"]
            isOneToOne: false
            referencedRelation: "topics"
            referencedColumns: ["id"]
          },
        ]
      }
      articles: {
        Row: {
          author_id: string
          created_at: string
          id: string
          published_at: string | null
          status: Database["public"]["Enums"]["content_status"]
        }
        Insert: {
          author_id: string
          created_at?: string
          id?: string
          published_at?: string | null
          status?: Database["public"]["Enums"]["content_status"]
        }
        Update: {
          author_id?: string
          created_at?: string
          id?: string
          published_at?: string | null
          status?: Database["public"]["Enums"]["content_status"]
        }
        Relationships: [
          {
            foreignKeyName: "articles_author_id_fkey"
            columns: ["author_id"]
            isOneToOne: false
            referencedRelation: "authors"
            referencedColumns: ["id"]
          },
        ]
      }
      audit_logs: {
        Row: {
          action: string
          actor_profile_id: string | null
          created_at: string
          entity_id: string | null
          entity_type: string
          id: string
          metadata: NonNullable<Json>
          reason: string | null
        }
        Insert: {
          action: string
          actor_profile_id?: string | null
          created_at?: string
          entity_id?: string | null
          entity_type: string
          id?: string
          metadata?: NonNullable<Json>
          reason?: string | null
        }
        Update: {
          action?: string
          actor_profile_id?: string | null
          created_at?: string
          entity_id?: string | null
          entity_type?: string
          id?: string
          metadata?: NonNullable<Json>
          reason?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "audit_logs_actor_profile_id_fkey"
            columns: ["actor_profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      author_localizations: {
        Row: {
          author_id: string
          description: string | null
          id: string
          locale: string
          name: string
          quote: string | null
          slug: string
          updated_at: string
        }
        Insert: {
          author_id: string
          description?: string | null
          id?: string
          locale: string
          name: string
          quote?: string | null
          slug: string
          updated_at?: string
        }
        Update: {
          author_id?: string
          description?: string | null
          id?: string
          locale?: string
          name?: string
          quote?: string | null
          slug?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "author_localizations_author_id_fkey"
            columns: ["author_id"]
            isOneToOne: false
            referencedRelation: "authors"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "author_localizations_locale_fkey"
            columns: ["locale"]
            isOneToOne: false
            referencedRelation: "supported_locales"
            referencedColumns: ["code"]
          },
        ]
      }
      authors: {
        Row: {
          accepts_questions: boolean
          biography: string | null
          canonical_slug: string
          created_at: string
          display_name: string
          id: string
          status: Database["public"]["Enums"]["content_status"]
          updated_at: string
        }
        Insert: {
          accepts_questions?: boolean
          biography?: string | null
          canonical_slug: string
          created_at?: string
          display_name: string
          id?: string
          status?: Database["public"]["Enums"]["content_status"]
          updated_at?: string
        }
        Update: {
          accepts_questions?: boolean
          biography?: string | null
          canonical_slug?: string
          created_at?: string
          display_name?: string
          id?: string
          status?: Database["public"]["Enums"]["content_status"]
          updated_at?: string
        }
        Relationships: []
      }
      book_language_editions: {
        Row: {
          book_id: string
          edition_id: string
          language_code: string
        }
        Insert: {
          book_id: string
          edition_id: string
          language_code: string
        }
        Update: {
          book_id?: string
          edition_id?: string
          language_code?: string
        }
        Relationships: [
          {
            foreignKeyName: "book_language_editions_edition_id_book_id_language_code_fkey"
            columns: ["edition_id", "book_id", "language_code"]
            isOneToOne: false
            referencedRelation: "editions"
            referencedColumns: ["id", "book_id", "language_code"]
          },
        ]
      }
      book_localizations: {
        Row: {
          audience: string | null
          book_id: string
          description: string | null
          faq: NonNullable<Json>
          id: string
          key_ideas: NonNullable<Json>
          locale: string
          seo_description: string | null
          seo_title: string | null
          short_description: string | null
          slug: string
          subtitle: string | null
          title: string
          updated_at: string
        }
        Insert: {
          audience?: string | null
          book_id: string
          description?: string | null
          faq?: NonNullable<Json>
          id?: string
          key_ideas?: NonNullable<Json>
          locale: string
          seo_description?: string | null
          seo_title?: string | null
          short_description?: string | null
          slug: string
          subtitle?: string | null
          title: string
          updated_at?: string
        }
        Update: {
          audience?: string | null
          book_id?: string
          description?: string | null
          faq?: NonNullable<Json>
          id?: string
          key_ideas?: NonNullable<Json>
          locale?: string
          seo_description?: string | null
          seo_title?: string | null
          short_description?: string | null
          slug?: string
          subtitle?: string | null
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "book_localizations_book_id_fkey"
            columns: ["book_id"]
            isOneToOne: false
            referencedRelation: "books"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "book_localizations_locale_fkey"
            columns: ["locale"]
            isOneToOne: false
            referencedRelation: "supported_locales"
            referencedColumns: ["code"]
          },
        ]
      }
      book_retail_links: {
        Row: {
          active: boolean
          book_id: string
          created_at: string
          currency: string | null
          id: string
          label: string | null
          position: number
          price_minor: number | null
          retailer: string
          updated_at: string
          url: string
        }
        Insert: {
          active?: boolean
          book_id: string
          created_at?: string
          currency?: string | null
          id?: string
          label?: string | null
          position: number
          price_minor?: number | null
          retailer: string
          updated_at?: string
          url: string
        }
        Update: {
          active?: boolean
          book_id?: string
          created_at?: string
          currency?: string | null
          id?: string
          label?: string | null
          position?: number
          price_minor?: number | null
          retailer?: string
          updated_at?: string
          url?: string
        }
        Relationships: [
          {
            foreignKeyName: "book_retail_links_book_id_fkey"
            columns: ["book_id"]
            isOneToOne: false
            referencedRelation: "books"
            referencedColumns: ["id"]
          },
        ]
      }
      book_reviews: {
        Row: {
          author_reply: string | null
          author_reply_at: string | null
          author_reply_notified_text: string | null
          body: string
          book_id: string
          created_at: string
          edition_id: string
          id: string
          locale: string
          profile_id: string
          published_at: string | null
          rating: number
          reviewer_name: string | null
          revision: number
          status: string
          updated_at: string
          book_review_json: Json | null
        }
        Insert: {
          author_reply?: string | null
          author_reply_at?: string | null
          author_reply_notified_text?: string | null
          body: string
          book_id: string
          created_at?: string
          edition_id: string
          id?: string
          locale: string
          profile_id: string
          published_at?: string | null
          rating: number
          reviewer_name?: string | null
          revision?: number
          status?: string
          updated_at?: string
        }
        Update: {
          author_reply?: string | null
          author_reply_at?: string | null
          author_reply_notified_text?: string | null
          body?: string
          book_id?: string
          created_at?: string
          edition_id?: string
          id?: string
          locale?: string
          profile_id?: string
          published_at?: string | null
          rating?: number
          reviewer_name?: string | null
          revision?: number
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "book_reviews_book_id_fkey"
            columns: ["book_id"]
            isOneToOne: false
            referencedRelation: "books"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "book_reviews_edition_book_fkey"
            columns: ["edition_id", "book_id"]
            isOneToOne: false
            referencedRelation: "editions"
            referencedColumns: ["id", "book_id"]
          },
          {
            foreignKeyName: "book_reviews_locale_fkey"
            columns: ["locale"]
            isOneToOne: false
            referencedRelation: "supported_locales"
            referencedColumns: ["code"]
          },
          {
            foreignKeyName: "book_reviews_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      book_samples: {
        Row: {
          allowed_hrefs: NonNullable<Json>
          id: string
          publication_id: string
        }
        Insert: {
          allowed_hrefs: NonNullable<Json>
          id?: string
          publication_id: string
        }
        Update: {
          allowed_hrefs?: NonNullable<Json>
          id?: string
          publication_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "book_samples_publication_id_fkey"
            columns: ["publication_id"]
            isOneToOne: true
            referencedRelation: "ebook_publications"
            referencedColumns: ["id"]
          },
        ]
      }
      book_series: {
        Row: {
          book_id: string
          position: number
          series_id: string
        }
        Insert: {
          book_id: string
          position: number
          series_id: string
        }
        Update: {
          book_id?: string
          position?: number
          series_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "book_series_book_id_fkey"
            columns: ["book_id"]
            isOneToOne: true
            referencedRelation: "books"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "book_series_series_id_fkey"
            columns: ["series_id"]
            isOneToOne: false
            referencedRelation: "series"
            referencedColumns: ["id"]
          },
        ]
      }
      book_topics: {
        Row: {
          book_id: string
          topic_id: string
        }
        Insert: {
          book_id: string
          topic_id: string
        }
        Update: {
          book_id?: string
          topic_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "book_topics_book_id_fkey"
            columns: ["book_id"]
            isOneToOne: false
            referencedRelation: "books"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "book_topics_topic_id_fkey"
            columns: ["topic_id"]
            isOneToOne: false
            referencedRelation: "topics"
            referencedColumns: ["id"]
          },
        ]
      }
      books: {
        Row: {
          canonical_key: string
          created_at: string
          default_content_language: string | null
          id: string
          original_language: string
          primary_author_id: string
          status: Database["public"]["Enums"]["content_status"]
          updated_at: string
        }
        Insert: {
          canonical_key: string
          created_at?: string
          default_content_language?: string | null
          id?: string
          original_language: string
          primary_author_id: string
          status?: Database["public"]["Enums"]["content_status"]
          updated_at?: string
        }
        Update: {
          canonical_key?: string
          created_at?: string
          default_content_language?: string | null
          id?: string
          original_language?: string
          primary_author_id?: string
          status?: Database["public"]["Enums"]["content_status"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "books_default_content_language_fkey"
            columns: ["default_content_language"]
            isOneToOne: false
            referencedRelation: "content_languages"
            referencedColumns: ["code"]
          },
          {
            foreignKeyName: "books_original_language_fkey"
            columns: ["original_language"]
            isOneToOne: false
            referencedRelation: "content_languages"
            referencedColumns: ["code"]
          },
          {
            foreignKeyName: "books_primary_author_id_fkey"
            columns: ["primary_author_id"]
            isOneToOne: false
            referencedRelation: "authors"
            referencedColumns: ["id"]
          },
        ]
      }
      bundle_editions: {
        Row: {
          bundle_id: string
          edition_id: string
          position: number
        }
        Insert: {
          bundle_id: string
          edition_id: string
          position: number
        }
        Update: {
          bundle_id?: string
          edition_id?: string
          position?: number
        }
        Relationships: [
          {
            foreignKeyName: "bundle_editions_bundle_id_fkey"
            columns: ["bundle_id"]
            isOneToOne: false
            referencedRelation: "bundles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bundle_editions_edition_id_fkey"
            columns: ["edition_id"]
            isOneToOne: false
            referencedRelation: "editions"
            referencedColumns: ["id"]
          },
        ]
      }
      bundle_localizations: {
        Row: {
          bundle_id: string
          description: string | null
          id: string
          locale: string
          slug: string
          subtitle: string | null
          title: string
          updated_at: string
        }
        Insert: {
          bundle_id: string
          description?: string | null
          id?: string
          locale: string
          slug: string
          subtitle?: string | null
          title: string
          updated_at?: string
        }
        Update: {
          bundle_id?: string
          description?: string | null
          id?: string
          locale?: string
          slug?: string
          subtitle?: string | null
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "bundle_localizations_bundle_id_fkey"
            columns: ["bundle_id"]
            isOneToOne: false
            referencedRelation: "bundles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bundle_localizations_locale_fkey"
            columns: ["locale"]
            isOneToOne: false
            referencedRelation: "supported_locales"
            referencedColumns: ["code"]
          },
        ]
      }
      bundles: {
        Row: {
          created_at: string
          id: string
          status: Database["public"]["Enums"]["content_status"]
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          status?: Database["public"]["Enums"]["content_status"]
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          status?: Database["public"]["Enums"]["content_status"]
          updated_at?: string
        }
        Relationships: []
      }
      commerce_settings: {
        Row: {
          id: boolean
          payable_currencies: string[]
          payment_provider: string
          payments_enabled: boolean
          updated_at: string
        }
        Insert: {
          id?: boolean
          payable_currencies?: string[]
          payment_provider?: string
          payments_enabled?: boolean
          updated_at?: string
        }
        Update: {
          id?: boolean
          payable_currencies?: string[]
          payment_provider?: string
          payments_enabled?: boolean
          updated_at?: string
        }
        Relationships: []
      }
      content_languages: {
        Row: {
          code: string
          name: string
        }
        Insert: {
          code: string
          name: string
        }
        Update: {
          code?: string
          name?: string
        }
        Relationships: []
      }
      coupon_attempts: {
        Row: {
          failure_count: number
          profile_id: string
          window_start: string
        }
        Insert: {
          failure_count?: number
          profile_id: string
          window_start?: string
        }
        Update: {
          failure_count?: number
          profile_id?: string
          window_start?: string
        }
        Relationships: [
          {
            foreignKeyName: "coupon_attempts_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: true
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      coupon_books: {
        Row: {
          book_id: string
          coupon_id: string
        }
        Insert: {
          book_id: string
          coupon_id: string
        }
        Update: {
          book_id?: string
          coupon_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "coupon_books_book_id_fkey"
            columns: ["book_id"]
            isOneToOne: false
            referencedRelation: "books"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "coupon_books_coupon_id_fkey"
            columns: ["coupon_id"]
            isOneToOne: false
            referencedRelation: "coupons"
            referencedColumns: ["id"]
          },
        ]
      }
      coupon_bundles: {
        Row: {
          bundle_id: string
          coupon_id: string
        }
        Insert: {
          bundle_id: string
          coupon_id: string
        }
        Update: {
          bundle_id?: string
          coupon_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "coupon_bundles_bundle_id_fkey"
            columns: ["bundle_id"]
            isOneToOne: false
            referencedRelation: "bundles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "coupon_bundles_coupon_id_fkey"
            columns: ["coupon_id"]
            isOneToOne: false
            referencedRelation: "coupons"
            referencedColumns: ["id"]
          },
        ]
      }
      coupon_redemptions: {
        Row: {
          coupon_id: string
          discount_minor: number
          id: string
          order_id: string
          profile_id: string
          redeemed_at: string | null
          reserved_at: string
          status: string
        }
        Insert: {
          coupon_id: string
          discount_minor: number
          id?: string
          order_id: string
          profile_id: string
          redeemed_at?: string | null
          reserved_at?: string
          status: string
        }
        Update: {
          coupon_id?: string
          discount_minor?: number
          id?: string
          order_id?: string
          profile_id?: string
          redeemed_at?: string | null
          reserved_at?: string
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "coupon_redemptions_coupon_id_fkey"
            columns: ["coupon_id"]
            isOneToOne: false
            referencedRelation: "coupons"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "coupon_redemptions_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: true
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "coupon_redemptions_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      coupons: {
        Row: {
          active: boolean
          amount_off_minor: number | null
          code: string
          created_at: string
          created_by: string | null
          currency: string | null
          ends_at: string | null
          id: string
          kind: string
          max_redemptions: number | null
          max_redemptions_per_profile: number
          note: string | null
          percent_off: number | null
          starts_at: string | null
        }
        Insert: {
          active?: boolean
          amount_off_minor?: number | null
          code: string
          created_at?: string
          created_by?: string | null
          currency?: string | null
          ends_at?: string | null
          id?: string
          kind: string
          max_redemptions?: number | null
          max_redemptions_per_profile?: number
          note?: string | null
          percent_off?: number | null
          starts_at?: string | null
        }
        Update: {
          active?: boolean
          amount_off_minor?: number | null
          code?: string
          created_at?: string
          created_by?: string | null
          currency?: string | null
          ends_at?: string | null
          id?: string
          kind?: string
          max_redemptions?: number | null
          max_redemptions_per_profile?: number
          note?: string | null
          percent_off?: number | null
          starts_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "coupons_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      customer_identities: {
        Row: {
          created_at: string
          id: string
          normalized_email: string
          profile_id: string | null
          verified_at: string | null
        }
        Insert: {
          created_at?: string
          id?: string
          normalized_email: string
          profile_id?: string | null
          verified_at?: string | null
        }
        Update: {
          created_at?: string
          id?: string
          normalized_email?: string
          profile_id?: string | null
          verified_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "customer_identities_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      ebook_assets: {
        Row: {
          created_at: string
          edition_id: string
          id: string
          source_checksum: string | null
          source_storage_key: string
          status: Database["public"]["Enums"]["ebook_asset_status"]
          version: number
        }
        Insert: {
          created_at?: string
          edition_id: string
          id?: string
          source_checksum?: string | null
          source_storage_key: string
          status?: Database["public"]["Enums"]["ebook_asset_status"]
          version: number
        }
        Update: {
          created_at?: string
          edition_id?: string
          id?: string
          source_checksum?: string | null
          source_storage_key?: string
          status?: Database["public"]["Enums"]["ebook_asset_status"]
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "ebook_assets_edition_id_fkey"
            columns: ["edition_id"]
            isOneToOne: false
            referencedRelation: "editions"
            referencedColumns: ["id"]
          },
        ]
      }
      ebook_publications: {
        Row: {
          ebook_asset_id: string
          epub_language: string | null
          id: string
          manifest_key: string
          positions_json: Json | null
          processed_at: string
          status: Database["public"]["Enums"]["publication_status"]
          toc_json: NonNullable<Json>
          version: number
        }
        Insert: {
          ebook_asset_id: string
          epub_language?: string | null
          id?: string
          manifest_key: string
          positions_json?: Json | null
          processed_at?: string
          status?: Database["public"]["Enums"]["publication_status"]
          toc_json?: NonNullable<Json>
          version: number
        }
        Update: {
          ebook_asset_id?: string
          epub_language?: string | null
          id?: string
          manifest_key?: string
          positions_json?: Json | null
          processed_at?: string
          status?: Database["public"]["Enums"]["publication_status"]
          toc_json?: NonNullable<Json>
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "ebook_publications_ebook_asset_id_version_fkey"
            columns: ["ebook_asset_id", "version"]
            isOneToOne: false
            referencedRelation: "ebook_assets"
            referencedColumns: ["id", "version"]
          },
        ]
      }
      ebook_resources: {
        Row: {
          access_class: string
          byte_size: number
          href: string
          id: string
          media_type: string
          publication_id: string
          sha256: string
          storage_key: string
        }
        Insert: {
          access_class: string
          byte_size: number
          href: string
          id?: string
          media_type: string
          publication_id: string
          sha256: string
          storage_key: string
        }
        Update: {
          access_class?: string
          byte_size?: number
          href?: string
          id?: string
          media_type?: string
          publication_id?: string
          sha256?: string
          storage_key?: string
        }
        Relationships: [
          {
            foreignKeyName: "ebook_resources_publication_id_fkey"
            columns: ["publication_id"]
            isOneToOne: false
            referencedRelation: "ebook_publications"
            referencedColumns: ["id"]
          },
        ]
      }
      ebook_search_chunks: {
        Row: {
          chapter_title: string | null
          href: string
          id: string
          locator_json: NonNullable<Json>
          normalized_search_document: unknown
          normalized_text: string
          ordinal: number
          plain_text: string
          publication_id: string
          search_document: unknown
        }
        Insert: {
          chapter_title?: string | null
          href: string
          id?: string
          locator_json: NonNullable<Json>
          normalized_search_document?: unknown
          normalized_text?: string
          ordinal: number
          plain_text: string
          publication_id: string
          search_document?: unknown
        }
        Update: {
          chapter_title?: string | null
          href?: string
          id?: string
          locator_json?: NonNullable<Json>
          normalized_search_document?: unknown
          normalized_text?: string
          ordinal?: number
          plain_text?: string
          publication_id?: string
          search_document?: unknown
        }
        Relationships: [
          {
            foreignKeyName: "ebook_search_chunks_publication_id_fkey"
            columns: ["publication_id"]
            isOneToOne: false
            referencedRelation: "ebook_publications"
            referencedColumns: ["id"]
          },
        ]
      }
      edition_default_offers: {
        Row: {
          edition_id: string
          offer_id: string
          sku_id: string
        }
        Insert: {
          edition_id: string
          offer_id: string
          sku_id: string
        }
        Update: {
          edition_id?: string
          offer_id?: string
          sku_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "edition_default_offers_edition_id_fkey"
            columns: ["edition_id"]
            isOneToOne: true
            referencedRelation: "editions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "edition_default_offers_offer_id_sku_id_fkey"
            columns: ["offer_id", "sku_id"]
            isOneToOne: false
            referencedRelation: "offers"
            referencedColumns: ["id", "sku_id"]
          },
          {
            foreignKeyName: "edition_default_offers_sku_id_edition_id_fkey"
            columns: ["sku_id", "edition_id"]
            isOneToOne: false
            referencedRelation: "skus"
            referencedColumns: ["id", "edition_id"]
          },
        ]
      }
      edition_feedback: {
        Row: {
          admin_note: string | null
          created_at: string
          edition_id: string
          handled_at: string | null
          handled_by: string | null
          id: string
          locator: Json | null
          message: string
          profile_id: string
          publication_id: string
          status: string
        }
        Insert: {
          admin_note?: string | null
          created_at?: string
          edition_id: string
          handled_at?: string | null
          handled_by?: string | null
          id?: string
          locator?: Json | null
          message: string
          profile_id: string
          publication_id: string
          status?: string
        }
        Update: {
          admin_note?: string | null
          created_at?: string
          edition_id?: string
          handled_at?: string | null
          handled_by?: string | null
          id?: string
          locator?: Json | null
          message?: string
          profile_id?: string
          publication_id?: string
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "edition_feedback_edition_id_fkey"
            columns: ["edition_id"]
            isOneToOne: false
            referencedRelation: "editions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "edition_feedback_handled_by_fkey"
            columns: ["handled_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "edition_feedback_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "edition_feedback_publication_id_fkey"
            columns: ["publication_id"]
            isOneToOne: false
            referencedRelation: "ebook_publications"
            referencedColumns: ["id"]
          },
        ]
      }
      edition_pricing_defaults: {
        Row: {
          currency: string
          language_code: string
          market_code: string
          price_minor: number
        }
        Insert: {
          currency: string
          language_code: string
          market_code: string
          price_minor: number
        }
        Update: {
          currency?: string
          language_code?: string
          market_code?: string
          price_minor?: number
        }
        Relationships: [
          {
            foreignKeyName: "edition_pricing_defaults_language_code_fkey"
            columns: ["language_code"]
            isOneToOne: false
            referencedRelation: "content_languages"
            referencedColumns: ["code"]
          },
        ]
      }
      editions: {
        Row: {
          active_publication_id: string | null
          book_id: string
          contributors: NonNullable<Json>
          edition_number: number
          editorial_state: string
          id: string
          introduction: string | null
          isbn: string | null
          language_code: string
          publication_date: string | null
          review_note: string | null
          reviewed_at: string | null
          reviewed_by: string | null
          rights_note: string | null
          status: Database["public"]["Enums"]["content_status"]
          territory_note: string | null
          text_source_note: string | null
          translation_source: string | null
        }
        Insert: {
          active_publication_id?: string | null
          book_id: string
          contributors?: NonNullable<Json>
          edition_number?: number
          editorial_state?: string
          id?: string
          introduction?: string | null
          isbn?: string | null
          language_code: string
          publication_date?: string | null
          review_note?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          rights_note?: string | null
          status?: Database["public"]["Enums"]["content_status"]
          territory_note?: string | null
          text_source_note?: string | null
          translation_source?: string | null
        }
        Update: {
          active_publication_id?: string | null
          book_id?: string
          contributors?: NonNullable<Json>
          edition_number?: number
          editorial_state?: string
          id?: string
          introduction?: string | null
          isbn?: string | null
          language_code?: string
          publication_date?: string | null
          review_note?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          rights_note?: string | null
          status?: Database["public"]["Enums"]["content_status"]
          territory_note?: string | null
          text_source_note?: string | null
          translation_source?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "editions_active_publication_id_fkey"
            columns: ["active_publication_id"]
            isOneToOne: false
            referencedRelation: "ebook_publications"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "editions_book_id_fkey"
            columns: ["book_id"]
            isOneToOne: false
            referencedRelation: "books"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "editions_language_code_fkey"
            columns: ["language_code"]
            isOneToOne: false
            referencedRelation: "content_languages"
            referencedColumns: ["code"]
          },
          {
            foreignKeyName: "editions_reviewed_by_fkey"
            columns: ["reviewed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      entitlements: {
        Row: {
          actor_profile_id: string | null
          book_id: string
          edition_id: string
          granted_at: string
          id: string
          profile_id: string
          reason: string | null
          revoked_at: string | null
          source_order_id: string | null
          source_type: Database["public"]["Enums"]["entitlement_source"]
          status: Database["public"]["Enums"]["entitlement_status"]
        }
        Insert: {
          actor_profile_id?: string | null
          book_id: string
          edition_id: string
          granted_at?: string
          id?: string
          profile_id: string
          reason?: string | null
          revoked_at?: string | null
          source_order_id?: string | null
          source_type: Database["public"]["Enums"]["entitlement_source"]
          status?: Database["public"]["Enums"]["entitlement_status"]
        }
        Update: {
          actor_profile_id?: string | null
          book_id?: string
          edition_id?: string
          granted_at?: string
          id?: string
          profile_id?: string
          reason?: string | null
          revoked_at?: string | null
          source_order_id?: string | null
          source_type?: Database["public"]["Enums"]["entitlement_source"]
          status?: Database["public"]["Enums"]["entitlement_status"]
        }
        Relationships: [
          {
            foreignKeyName: "entitlements_actor_profile_id_fkey"
            columns: ["actor_profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "entitlements_book_id_fkey"
            columns: ["book_id"]
            isOneToOne: false
            referencedRelation: "books"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "entitlements_edition_book_fkey"
            columns: ["edition_id", "book_id"]
            isOneToOne: false
            referencedRelation: "editions"
            referencedColumns: ["id", "book_id"]
          },
          {
            foreignKeyName: "entitlements_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "entitlements_source_order_id_fkey"
            columns: ["source_order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
        ]
      }
      gifts: {
        Row: {
          claim_token_hash: string
          claimed_at: string | null
          claimed_by_profile_id: string | null
          created_at: string
          id: string
          message: string | null
          order_id: string
          purchaser_profile_id: string
          recipient_email: string
          revoked_at: string | null
          revoked_reason: string | null
          status: string
        }
        Insert: {
          claim_token_hash: string
          claimed_at?: string | null
          claimed_by_profile_id?: string | null
          created_at?: string
          id?: string
          message?: string | null
          order_id: string
          purchaser_profile_id: string
          recipient_email: string
          revoked_at?: string | null
          revoked_reason?: string | null
          status: string
        }
        Update: {
          claim_token_hash?: string
          claimed_at?: string | null
          claimed_by_profile_id?: string | null
          created_at?: string
          id?: string
          message?: string | null
          order_id?: string
          purchaser_profile_id?: string
          recipient_email?: string
          revoked_at?: string | null
          revoked_reason?: string | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "gifts_claimed_by_profile_id_fkey"
            columns: ["claimed_by_profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "gifts_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: true
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "gifts_purchaser_profile_id_fkey"
            columns: ["purchaser_profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      home_hero: {
        Row: {
          alt_text: string
          desktop_storage_key: string
          id: boolean
          mobile_storage_key: string
          updated_at: string
        }
        Insert: {
          alt_text: string
          desktop_storage_key: string
          id?: boolean
          mobile_storage_key: string
          updated_at?: string
        }
        Update: {
          alt_text?: string
          desktop_storage_key?: string
          id?: boolean
          mobile_storage_key?: string
          updated_at?: string
        }
        Relationships: []
      }
      idea_books: {
        Row: {
          book_id: string
          idea_id: string
          position: number
        }
        Insert: {
          book_id: string
          idea_id: string
          position: number
        }
        Update: {
          book_id?: string
          idea_id?: string
          position?: number
        }
        Relationships: [
          {
            foreignKeyName: "idea_books_book_id_fkey"
            columns: ["book_id"]
            isOneToOne: false
            referencedRelation: "books"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "idea_books_idea_id_fkey"
            columns: ["idea_id"]
            isOneToOne: false
            referencedRelation: "ideas"
            referencedColumns: ["id"]
          },
        ]
      }
      idea_links: {
        Row: {
          idea_id: string
          position: number
          related_idea_id: string
        }
        Insert: {
          idea_id: string
          position: number
          related_idea_id: string
        }
        Update: {
          idea_id?: string
          position?: number
          related_idea_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "idea_links_idea_id_fkey"
            columns: ["idea_id"]
            isOneToOne: false
            referencedRelation: "ideas"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "idea_links_related_idea_id_fkey"
            columns: ["related_idea_id"]
            isOneToOne: false
            referencedRelation: "ideas"
            referencedColumns: ["id"]
          },
        ]
      }
      idea_localizations: {
        Row: {
          body_blocks: NonNullable<Json>
          id: string
          idea_id: string
          locale: string
          question: string
          seo_description: string | null
          seo_title: string | null
          short_answer: string
          slug: string
          updated_at: string
        }
        Insert: {
          body_blocks?: NonNullable<Json>
          id?: string
          idea_id: string
          locale: string
          question: string
          seo_description?: string | null
          seo_title?: string | null
          short_answer: string
          slug: string
          updated_at?: string
        }
        Update: {
          body_blocks?: NonNullable<Json>
          id?: string
          idea_id?: string
          locale?: string
          question?: string
          seo_description?: string | null
          seo_title?: string | null
          short_answer?: string
          slug?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "idea_localizations_idea_id_fkey"
            columns: ["idea_id"]
            isOneToOne: false
            referencedRelation: "ideas"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "idea_localizations_locale_fkey"
            columns: ["locale"]
            isOneToOne: false
            referencedRelation: "supported_locales"
            referencedColumns: ["code"]
          },
        ]
      }
      idea_topics: {
        Row: {
          idea_id: string
          topic_id: string
        }
        Insert: {
          idea_id: string
          topic_id: string
        }
        Update: {
          idea_id?: string
          topic_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "idea_topics_idea_id_fkey"
            columns: ["idea_id"]
            isOneToOne: false
            referencedRelation: "ideas"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "idea_topics_topic_id_fkey"
            columns: ["topic_id"]
            isOneToOne: false
            referencedRelation: "topics"
            referencedColumns: ["id"]
          },
        ]
      }
      ideas: {
        Row: {
          created_at: string
          id: string
          status: Database["public"]["Enums"]["content_status"]
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          status?: Database["public"]["Enums"]["content_status"]
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          status?: Database["public"]["Enums"]["content_status"]
          updated_at?: string
        }
        Relationships: []
      }
      library_items: {
        Row: {
          added_at: string
          book_id: string
          edition_id: string
          entitlement_id: string
          id: string
          profile_id: string
          state: Database["public"]["Enums"]["library_state"]
        }
        Insert: {
          added_at?: string
          book_id: string
          edition_id: string
          entitlement_id: string
          id?: string
          profile_id: string
          state?: Database["public"]["Enums"]["library_state"]
        }
        Update: {
          added_at?: string
          book_id?: string
          edition_id?: string
          entitlement_id?: string
          id?: string
          profile_id?: string
          state?: Database["public"]["Enums"]["library_state"]
        }
        Relationships: [
          {
            foreignKeyName: "library_items_book_id_fkey"
            columns: ["book_id"]
            isOneToOne: false
            referencedRelation: "books"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "library_items_edition_book_fkey"
            columns: ["edition_id", "book_id"]
            isOneToOne: false
            referencedRelation: "editions"
            referencedColumns: ["id", "book_id"]
          },
          {
            foreignKeyName: "library_items_entitlement_id_fkey"
            columns: ["entitlement_id"]
            isOneToOne: false
            referencedRelation: "entitlements"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "library_items_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      manual_payment_confirmations: {
        Row: {
          admin_profile_id: string
          bank_reference: string
          confirmed_at: string
          mismatch_accepted: boolean
          note: string | null
          order_id: string
          received_amount_minor: number
        }
        Insert: {
          admin_profile_id: string
          bank_reference: string
          confirmed_at?: string
          mismatch_accepted?: boolean
          note?: string | null
          order_id: string
          received_amount_minor: number
        }
        Update: {
          admin_profile_id?: string
          bank_reference?: string
          confirmed_at?: string
          mismatch_accepted?: boolean
          note?: string | null
          order_id?: string
          received_amount_minor?: number
        }
        Relationships: [
          {
            foreignKeyName: "manual_payment_confirmations_admin_profile_id_fkey"
            columns: ["admin_profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "manual_payment_confirmations_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: true
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
        ]
      }
      manual_payment_declines: {
        Row: {
          admin_profile_id: string
          declined_at: string
          id: string
          order_id: string
          outcome: string
          reason: string
          sequence: number
        }
        Insert: {
          admin_profile_id: string
          declined_at?: string
          id?: string
          order_id: string
          outcome: string
          reason: string
          sequence: number
        }
        Update: {
          admin_profile_id?: string
          declined_at?: string
          id?: string
          order_id?: string
          outcome?: string
          reason?: string
          sequence?: number
        }
        Relationships: [
          {
            foreignKeyName: "manual_payment_declines_admin_profile_id_fkey"
            columns: ["admin_profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "manual_payment_declines_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
        ]
      }
      manual_transfer_claims: {
        Row: {
          claimed_at: string
          note: string | null
          order_id: string
          profile_id: string
        }
        Insert: {
          claimed_at?: string
          note?: string | null
          order_id: string
          profile_id: string
        }
        Update: {
          claimed_at?: string
          note?: string | null
          order_id?: string
          profile_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "manual_transfer_claims_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: true
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "manual_transfer_claims_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      media_assets: {
        Row: {
          alt_text: string
          created_at: string
          height: number | null
          id: string
          kind: string
          owner_id: string
          owner_type: string
          storage_key: string
          width: number | null
        }
        Insert: {
          alt_text: string
          created_at?: string
          height?: number | null
          id?: string
          kind: string
          owner_id: string
          owner_type: string
          storage_key: string
          width?: number | null
        }
        Update: {
          alt_text?: string
          created_at?: string
          height?: number | null
          id?: string
          kind?: string
          owner_id?: string
          owner_type?: string
          storage_key?: string
          width?: number | null
        }
        Relationships: []
      }
      merchandising_slots: {
        Row: {
          active: boolean
          book_id: string | null
          id: string
          position: number
          slot_key: string
        }
        Insert: {
          active?: boolean
          book_id?: string | null
          id?: string
          position?: number
          slot_key: string
        }
        Update: {
          active?: boolean
          book_id?: string | null
          id?: string
          position?: number
          slot_key?: string
        }
        Relationships: [
          {
            foreignKeyName: "merchandising_slots_book_id_fkey"
            columns: ["book_id"]
            isOneToOne: false
            referencedRelation: "books"
            referencedColumns: ["id"]
          },
        ]
      }
      notification_outbox: {
        Row: {
          attempt_count: number
          available_at: string
          created_at: string
          delivery_generation: number
          entitlement_id: string | null
          gift_id: string | null
          id: string
          last_error_code: string | null
          lease_expires_at: string | null
          lease_token: string | null
          payload: Json | null
          profile_id: string | null
          provider_message_id: string | null
          question_delivery_started: boolean
          question_id: string | null
          review_id: string | null
          sent_at: string | null
          template_key: string
        }
        Insert: {
          attempt_count?: number
          available_at?: string
          created_at?: string
          delivery_generation?: number
          entitlement_id?: string | null
          gift_id?: string | null
          id?: string
          last_error_code?: string | null
          lease_expires_at?: string | null
          lease_token?: string | null
          payload?: Json | null
          profile_id?: string | null
          provider_message_id?: string | null
          question_delivery_started?: boolean
          question_id?: string | null
          review_id?: string | null
          sent_at?: string | null
          template_key: string
        }
        Update: {
          attempt_count?: number
          available_at?: string
          created_at?: string
          delivery_generation?: number
          entitlement_id?: string | null
          gift_id?: string | null
          id?: string
          last_error_code?: string | null
          lease_expires_at?: string | null
          lease_token?: string | null
          payload?: Json | null
          profile_id?: string | null
          provider_message_id?: string | null
          question_delivery_started?: boolean
          question_id?: string | null
          review_id?: string | null
          sent_at?: string | null
          template_key?: string
        }
        Relationships: [
          {
            foreignKeyName: "notification_outbox_entitlement_id_fkey"
            columns: ["entitlement_id"]
            isOneToOne: true
            referencedRelation: "entitlements"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notification_outbox_gift_id_fkey"
            columns: ["gift_id"]
            isOneToOne: true
            referencedRelation: "gift_summaries"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notification_outbox_gift_id_fkey"
            columns: ["gift_id"]
            isOneToOne: true
            referencedRelation: "gifts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notification_outbox_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notification_outbox_question_id_fkey"
            columns: ["question_id"]
            isOneToOne: true
            referencedRelation: "reader_questions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notification_outbox_review_id_fkey"
            columns: ["review_id"]
            isOneToOne: false
            referencedRelation: "book_reviews"
            referencedColumns: ["id"]
          },
        ]
      }
      offers: {
        Row: {
          active: boolean
          bundle_id: string | null
          currency: string
          ends_at: string | null
          id: string
          market_code: string
          price_minor: number
          sale_amount_off_minor: number | null
          sale_ends_at: string | null
          sale_kind: string | null
          sale_percent_off: number | null
          sale_starts_at: string | null
          sku_id: string | null
          starts_at: string | null
          offer_effective_price_minor: number | null
        }
        Insert: {
          active?: boolean
          bundle_id?: string | null
          currency: string
          ends_at?: string | null
          id?: string
          market_code: string
          price_minor: number
          sale_amount_off_minor?: number | null
          sale_ends_at?: string | null
          sale_kind?: string | null
          sale_percent_off?: number | null
          sale_starts_at?: string | null
          sku_id?: string | null
          starts_at?: string | null
        }
        Update: {
          active?: boolean
          bundle_id?: string | null
          currency?: string
          ends_at?: string | null
          id?: string
          market_code?: string
          price_minor?: number
          sale_amount_off_minor?: number | null
          sale_ends_at?: string | null
          sale_kind?: string | null
          sale_percent_off?: number | null
          sale_starts_at?: string | null
          sku_id?: string | null
          starts_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "offers_bundle_id_fkey"
            columns: ["bundle_id"]
            isOneToOne: false
            referencedRelation: "bundles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "offers_sku_id_fkey"
            columns: ["sku_id"]
            isOneToOne: false
            referencedRelation: "skus"
            referencedColumns: ["id"]
          },
        ]
      }
      operations_alert_state: {
        Row: {
          active: boolean
          fingerprint: string | null
          first_detected_at: string | null
          last_alerted_at: string | null
          last_evaluated_at: string | null
          resolved_at: string | null
          rule_name: string
        }
        Insert: {
          active?: boolean
          fingerprint?: string | null
          first_detected_at?: string | null
          last_alerted_at?: string | null
          last_evaluated_at?: string | null
          resolved_at?: string | null
          rule_name: string
        }
        Update: {
          active?: boolean
          fingerprint?: string | null
          first_detected_at?: string | null
          last_alerted_at?: string | null
          last_evaluated_at?: string | null
          resolved_at?: string | null
          rule_name?: string
        }
        Relationships: []
      }
      order_items: {
        Row: {
          book_id: string
          edition_id: string
          id: string
          language_code: string | null
          offer_id: string | null
          order_id: string
          position: number
          quantity: number
          sku_id: string
          title_snapshot: string
          unit_price_minor: number
        }
        Insert: {
          book_id: string
          edition_id: string
          id?: string
          language_code?: string | null
          offer_id?: string | null
          order_id: string
          position?: number
          quantity?: number
          sku_id: string
          title_snapshot: string
          unit_price_minor: number
        }
        Update: {
          book_id?: string
          edition_id?: string
          id?: string
          language_code?: string | null
          offer_id?: string | null
          order_id?: string
          position?: number
          quantity?: number
          sku_id?: string
          title_snapshot?: string
          unit_price_minor?: number
        }
        Relationships: [
          {
            foreignKeyName: "order_items_book_id_fkey"
            columns: ["book_id"]
            isOneToOne: false
            referencedRelation: "books"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "order_items_edition_book_fkey"
            columns: ["edition_id", "book_id"]
            isOneToOne: false
            referencedRelation: "editions"
            referencedColumns: ["id", "book_id"]
          },
          {
            foreignKeyName: "order_items_language_code_fkey"
            columns: ["language_code"]
            isOneToOne: false
            referencedRelation: "content_languages"
            referencedColumns: ["code"]
          },
          {
            foreignKeyName: "order_items_offer_id_fkey"
            columns: ["offer_id"]
            isOneToOne: false
            referencedRelation: "offers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "order_items_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "order_items_sku_id_fkey"
            columns: ["sku_id"]
            isOneToOne: false
            referencedRelation: "skus"
            referencedColumns: ["id"]
          },
        ]
      }
      orders: {
        Row: {
          bundle_id: string | null
          coupon_code: string | null
          coupon_id: string | null
          created_at: string
          currency: string
          discount_minor: number
          id: string
          market_code: string
          payment_provider: string
          payment_status: Database["public"]["Enums"]["payment_status"]
          profile_id: string
          reference_code: string
          status: Database["public"]["Enums"]["order_status"]
          subtotal_minor: number
          title_snapshot: string | null
          total_minor: number
        }
        Insert: {
          bundle_id?: string | null
          coupon_code?: string | null
          coupon_id?: string | null
          created_at?: string
          currency: string
          discount_minor?: number
          id?: string
          market_code: string
          payment_provider?: string
          payment_status: Database["public"]["Enums"]["payment_status"]
          profile_id: string
          reference_code: string
          status: Database["public"]["Enums"]["order_status"]
          subtotal_minor: number
          title_snapshot?: string | null
          total_minor: number
        }
        Update: {
          bundle_id?: string | null
          coupon_code?: string | null
          coupon_id?: string | null
          created_at?: string
          currency?: string
          discount_minor?: number
          id?: string
          market_code?: string
          payment_provider?: string
          payment_status?: Database["public"]["Enums"]["payment_status"]
          profile_id?: string
          reference_code?: string
          status?: Database["public"]["Enums"]["order_status"]
          subtotal_minor?: number
          title_snapshot?: string | null
          total_minor?: number
        }
        Relationships: [
          {
            foreignKeyName: "orders_bundle_id_fkey"
            columns: ["bundle_id"]
            isOneToOne: false
            referencedRelation: "bundles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "orders_coupon_id_fkey"
            columns: ["coupon_id"]
            isOneToOne: false
            referencedRelation: "coupons"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "orders_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      payment_events: {
        Row: {
          id: string
          payload_hash: string
          payment_id: string
          processed_at: string | null
          provider: string
          provider_event_id: string
          received_at: string
        }
        Insert: {
          id?: string
          payload_hash: string
          payment_id: string
          processed_at?: string | null
          provider: string
          provider_event_id: string
          received_at?: string
        }
        Update: {
          id?: string
          payload_hash?: string
          payment_id?: string
          processed_at?: string | null
          provider?: string
          provider_event_id?: string
          received_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "payment_events_payment_id_fkey"
            columns: ["payment_id"]
            isOneToOne: false
            referencedRelation: "payments"
            referencedColumns: ["id"]
          },
        ]
      }
      payments: {
        Row: {
          amount_minor: number
          created_at: string
          currency: string
          external_payment_id: string | null
          id: string
          order_id: string
          provider: string
          status: Database["public"]["Enums"]["payment_status"]
        }
        Insert: {
          amount_minor: number
          created_at?: string
          currency: string
          external_payment_id?: string | null
          id?: string
          order_id: string
          provider: string
          status: Database["public"]["Enums"]["payment_status"]
        }
        Update: {
          amount_minor?: number
          created_at?: string
          currency?: string
          external_payment_id?: string | null
          id?: string
          order_id?: string
          provider?: string
          status?: Database["public"]["Enums"]["payment_status"]
        }
        Relationships: [
          {
            foreignKeyName: "payments_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
        ]
      }
      platform_settings: {
        Row: {
          default_content_language: string
          default_metadata_locale: string
          default_ui_locale: string
          singleton: boolean
          updated_at: string
        }
        Insert: {
          default_content_language?: string
          default_metadata_locale?: string
          default_ui_locale?: string
          singleton?: boolean
          updated_at?: string
        }
        Update: {
          default_content_language?: string
          default_metadata_locale?: string
          default_ui_locale?: string
          singleton?: boolean
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "platform_settings_default_content_language_fkey"
            columns: ["default_content_language"]
            isOneToOne: false
            referencedRelation: "content_languages"
            referencedColumns: ["code"]
          },
          {
            foreignKeyName: "platform_settings_default_metadata_locale_fkey"
            columns: ["default_metadata_locale"]
            isOneToOne: false
            referencedRelation: "supported_locales"
            referencedColumns: ["code"]
          },
          {
            foreignKeyName: "platform_settings_default_ui_locale_fkey"
            columns: ["default_ui_locale"]
            isOneToOne: false
            referencedRelation: "supported_locales"
            referencedColumns: ["code"]
          },
        ]
      }
      processing_jobs: {
        Row: {
          attempt: number
          correlation_id: string
          created_at: string
          error_code: string | null
          error_message: string | null
          id: string
          lease_expires_at: string | null
          lease_owner: string | null
          status: Database["public"]["Enums"]["processing_job_status"]
          target_id: string
          updated_at: string
        }
        Insert: {
          attempt?: number
          correlation_id: string
          created_at?: string
          error_code?: string | null
          error_message?: string | null
          id?: string
          lease_expires_at?: string | null
          lease_owner?: string | null
          status?: Database["public"]["Enums"]["processing_job_status"]
          target_id: string
          updated_at?: string
        }
        Update: {
          attempt?: number
          correlation_id?: string
          created_at?: string
          error_code?: string | null
          error_message?: string | null
          id?: string
          lease_expires_at?: string | null
          lease_owner?: string | null
          status?: Database["public"]["Enums"]["processing_job_status"]
          target_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "processing_jobs_target_id_fkey"
            columns: ["target_id"]
            isOneToOne: false
            referencedRelation: "ebook_assets"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          auth_user_id: string
          created_at: string
          display_name: string | null
          id: string
          locale: string
          updated_at: string
        }
        Insert: {
          auth_user_id: string
          created_at?: string
          display_name?: string | null
          id?: string
          locale?: string
          updated_at?: string
        }
        Update: {
          auth_user_id?: string
          created_at?: string
          display_name?: string | null
          id?: string
          locale?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "profiles_locale_fkey"
            columns: ["locale"]
            isOneToOne: false
            referencedRelation: "supported_locales"
            referencedColumns: ["code"]
          },
        ]
      }
      reader_annotations: {
        Row: {
          color: string | null
          created_at: string
          id: string
          kind: string
          label: string | null
          locator_json: NonNullable<Json>
          note_text: string | null
          profile_id: string
          publication_id: string
          selected_text: string | null
          updated_at: string
        }
        Insert: {
          color?: string | null
          created_at?: string
          id?: string
          kind: string
          label?: string | null
          locator_json: NonNullable<Json>
          note_text?: string | null
          profile_id: string
          publication_id: string
          selected_text?: string | null
          updated_at?: string
        }
        Update: {
          color?: string | null
          created_at?: string
          id?: string
          kind?: string
          label?: string | null
          locator_json?: NonNullable<Json>
          note_text?: string | null
          profile_id?: string
          publication_id?: string
          selected_text?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "reader_annotations_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reader_annotations_publication_id_fkey"
            columns: ["publication_id"]
            isOneToOne: false
            referencedRelation: "ebook_publications"
            referencedColumns: ["id"]
          },
        ]
      }
      reader_questions: {
        Row: {
          answer_idea_id: string | null
          answered_at: string | null
          body: string
          book_id: string | null
          created_at: string
          id: string
          idea_id: string | null
          locale: string
          notified_at: string | null
          profile_id: string
          status: string
        }
        Insert: {
          answer_idea_id?: string | null
          answered_at?: string | null
          body: string
          book_id?: string | null
          created_at?: string
          id?: string
          idea_id?: string | null
          locale: string
          notified_at?: string | null
          profile_id: string
          status?: string
        }
        Update: {
          answer_idea_id?: string | null
          answered_at?: string | null
          body?: string
          book_id?: string | null
          created_at?: string
          id?: string
          idea_id?: string | null
          locale?: string
          notified_at?: string | null
          profile_id?: string
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "reader_questions_answer_idea_id_fkey"
            columns: ["answer_idea_id"]
            isOneToOne: false
            referencedRelation: "ideas"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reader_questions_book_id_fkey"
            columns: ["book_id"]
            isOneToOne: false
            referencedRelation: "books"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reader_questions_idea_id_fkey"
            columns: ["idea_id"]
            isOneToOne: false
            referencedRelation: "ideas"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reader_questions_locale_fkey"
            columns: ["locale"]
            isOneToOne: false
            referencedRelation: "supported_locales"
            referencedColumns: ["code"]
          },
          {
            foreignKeyName: "reader_questions_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      reader_sessions: {
        Row: {
          created_at: string
          expires_at: string
          id: string
          profile_id: string
          publication_id: string
          publication_version: number
          revoked_at: string | null
        }
        Insert: {
          created_at?: string
          expires_at: string
          id?: string
          profile_id: string
          publication_id: string
          publication_version: number
          revoked_at?: string | null
        }
        Update: {
          created_at?: string
          expires_at?: string
          id?: string
          profile_id?: string
          publication_id?: string
          publication_version?: number
          revoked_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "reader_sessions_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reader_sessions_publication_id_publication_version_fkey"
            columns: ["publication_id", "publication_version"]
            isOneToOne: false
            referencedRelation: "ebook_publications"
            referencedColumns: ["id", "version"]
          },
        ]
      }
      reading_progress: {
        Row: {
          client_sequence: number
          device_id: string
          id: string
          locator_json: NonNullable<Json>
          profile_id: string
          progression: number
          publication_id: string
          total_progression: number | null
          updated_at: string
        }
        Insert: {
          client_sequence: number
          device_id: string
          id?: string
          locator_json: NonNullable<Json>
          profile_id: string
          progression: number
          publication_id: string
          total_progression?: number | null
          updated_at?: string
        }
        Update: {
          client_sequence?: number
          device_id?: string
          id?: string
          locator_json?: NonNullable<Json>
          profile_id?: string
          progression?: number
          publication_id?: string
          total_progression?: number | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "reading_progress_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reading_progress_publication_id_fkey"
            columns: ["publication_id"]
            isOneToOne: false
            referencedRelation: "ebook_publications"
            referencedColumns: ["id"]
          },
        ]
      }
      redirects: {
        Row: {
          created_at: string
          destination_path: string
          id: string
          source_path: string
        }
        Insert: {
          created_at?: string
          destination_path: string
          id?: string
          source_path: string
        }
        Update: {
          created_at?: string
          destination_path?: string
          id?: string
          source_path?: string
        }
        Relationships: []
      }
      related_books: {
        Row: {
          book_id: string
          position: number
          related_book_id: string
        }
        Insert: {
          book_id: string
          position: number
          related_book_id: string
        }
        Update: {
          book_id?: string
          position?: number
          related_book_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "related_books_book_id_fkey"
            columns: ["book_id"]
            isOneToOne: false
            referencedRelation: "books"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "related_books_related_book_id_fkey"
            columns: ["related_book_id"]
            isOneToOne: false
            referencedRelation: "books"
            referencedColumns: ["id"]
          },
        ]
      }
      series: {
        Row: {
          canonical_slug: string
          created_at: string
          display_name: string
          id: string
          status: Database["public"]["Enums"]["content_status"]
          updated_at: string
        }
        Insert: {
          canonical_slug: string
          created_at?: string
          display_name: string
          id?: string
          status?: Database["public"]["Enums"]["content_status"]
          updated_at?: string
        }
        Update: {
          canonical_slug?: string
          created_at?: string
          display_name?: string
          id?: string
          status?: Database["public"]["Enums"]["content_status"]
          updated_at?: string
        }
        Relationships: []
      }
      series_localizations: {
        Row: {
          description: string | null
          id: string
          locale: string
          name: string
          series_id: string
          slug: string
          updated_at: string
        }
        Insert: {
          description?: string | null
          id?: string
          locale: string
          name: string
          series_id: string
          slug: string
          updated_at?: string
        }
        Update: {
          description?: string | null
          id?: string
          locale?: string
          name?: string
          series_id?: string
          slug?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "series_localizations_locale_fkey"
            columns: ["locale"]
            isOneToOne: false
            referencedRelation: "supported_locales"
            referencedColumns: ["code"]
          },
          {
            foreignKeyName: "series_localizations_series_id_fkey"
            columns: ["series_id"]
            isOneToOne: false
            referencedRelation: "series"
            referencedColumns: ["id"]
          },
        ]
      }
      shared_quotes: {
        Row: {
          book_id: string
          code: string
          created_at: string
          id: string
          locale: string
          profile_id: string
          publication_id: string | null
          quote: string
          removed_by: string | null
          status: string
          updated_at: string
          shared_quote_json: Json | null
        }
        Insert: {
          book_id: string
          code: string
          created_at?: string
          id?: string
          locale: string
          profile_id: string
          publication_id?: string | null
          quote: string
          removed_by?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          book_id?: string
          code?: string
          created_at?: string
          id?: string
          locale?: string
          profile_id?: string
          publication_id?: string | null
          quote?: string
          removed_by?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "shared_quotes_book_id_fkey"
            columns: ["book_id"]
            isOneToOne: false
            referencedRelation: "books"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shared_quotes_locale_fkey"
            columns: ["locale"]
            isOneToOne: false
            referencedRelation: "supported_locales"
            referencedColumns: ["code"]
          },
          {
            foreignKeyName: "shared_quotes_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shared_quotes_publication_id_fkey"
            columns: ["publication_id"]
            isOneToOne: false
            referencedRelation: "ebook_publications"
            referencedColumns: ["id"]
          },
        ]
      }
      skus: {
        Row: {
          active: boolean
          edition_id: string
          format: Database["public"]["Enums"]["sku_format"]
          id: string
          sku_code: string
        }
        Insert: {
          active?: boolean
          edition_id: string
          format?: Database["public"]["Enums"]["sku_format"]
          id?: string
          sku_code: string
        }
        Update: {
          active?: boolean
          edition_id?: string
          format?: Database["public"]["Enums"]["sku_format"]
          id?: string
          sku_code?: string
        }
        Relationships: [
          {
            foreignKeyName: "skus_edition_id_fkey"
            columns: ["edition_id"]
            isOneToOne: false
            referencedRelation: "editions"
            referencedColumns: ["id"]
          },
        ]
      }
      supported_locales: {
        Row: {
          code: string
          created_at: string
          enabled: boolean
          native_name: string
        }
        Insert: {
          code: string
          created_at?: string
          enabled?: boolean
          native_name: string
        }
        Update: {
          code?: string
          created_at?: string
          enabled?: boolean
          native_name?: string
        }
        Relationships: []
      }
      topic_localizations: {
        Row: {
          description: string | null
          id: string
          locale: string
          name: string
          slug: string
          topic_id: string
          updated_at: string
        }
        Insert: {
          description?: string | null
          id?: string
          locale: string
          name: string
          slug: string
          topic_id: string
          updated_at?: string
        }
        Update: {
          description?: string | null
          id?: string
          locale?: string
          name?: string
          slug?: string
          topic_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "topic_localizations_locale_fkey"
            columns: ["locale"]
            isOneToOne: false
            referencedRelation: "supported_locales"
            referencedColumns: ["code"]
          },
          {
            foreignKeyName: "topic_localizations_topic_id_fkey"
            columns: ["topic_id"]
            isOneToOne: false
            referencedRelation: "topics"
            referencedColumns: ["id"]
          },
        ]
      }
      topics: {
        Row: {
          canonical_slug: string
          description: string | null
          id: string
          name: string
          status: Database["public"]["Enums"]["content_status"]
        }
        Insert: {
          canonical_slug: string
          description?: string | null
          id?: string
          name: string
          status?: Database["public"]["Enums"]["content_status"]
        }
        Update: {
          canonical_slug?: string
          description?: string | null
          id?: string
          name?: string
          status?: Database["public"]["Enums"]["content_status"]
        }
        Relationships: []
      }
      user_roles: {
        Row: {
          granted_at: string
          profile_id: string
          role: string
        }
        Insert: {
          granted_at?: string
          profile_id: string
          role: string
        }
        Update: {
          granted_at?: string
          profile_id?: string
          role?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_roles_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: true
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      bundle_works: {
        Row: {
          book_id: string | null
          bundle_id: string | null
          position: number | null
        }
        Relationships: [
          {
            foreignKeyName: "bundle_editions_bundle_id_fkey"
            columns: ["bundle_id"]
            isOneToOne: false
            referencedRelation: "bundles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "editions_book_id_fkey"
            columns: ["book_id"]
            isOneToOne: false
            referencedRelation: "books"
            referencedColumns: ["id"]
          },
        ]
      }
      gift_summaries: {
        Row: {
          claimed_at: string | null
          claimed_by_profile_id: string | null
          created_at: string | null
          id: string | null
          message: string | null
          order_id: string | null
          purchaser_profile_id: string | null
          recipient_email: string | null
          revoked_at: string | null
          revoked_reason: string | null
          status: string | null
        }
        Insert: {
          claimed_at?: string | null
          claimed_by_profile_id?: string | null
          created_at?: string | null
          id?: string | null
          message?: string | null
          order_id?: string | null
          purchaser_profile_id?: string | null
          recipient_email?: string | null
          revoked_at?: string | null
          revoked_reason?: string | null
          status?: string | null
        }
        Update: {
          claimed_at?: string | null
          claimed_by_profile_id?: string | null
          created_at?: string | null
          id?: string | null
          message?: string | null
          order_id?: string | null
          purchaser_profile_id?: string | null
          recipient_email?: string | null
          revoked_at?: string | null
          revoked_reason?: string | null
          status?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "gifts_claimed_by_profile_id_fkey"
            columns: ["claimed_by_profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "gifts_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: true
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "gifts_purchaser_profile_id_fkey"
            columns: ["purchaser_profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Functions: {
      acquire_free_edition: { Args: { p_edition_id: string }; Returns: string }
      activate_order_gift: { Args: { p_order_id: string }; Returns: boolean }
      admin_answer_question: {
        Args: { p_idea_id: string; p_question_id: string }
        Returns: undefined
      }
      admin_answer_question_with_idea: {
        Args: {
          p_locale: string
          p_question: string
          p_question_id: string
          p_short_answer: string
          p_slug: string
        }
        Returns: string
      }
      admin_archive_question: {
        Args: { p_question_id: string }
        Returns: undefined
      }
      admin_clear_home_hero: {
        Args: Record<PropertyKey, never>
        Returns: undefined
      }
      admin_create_article: {
        Args: {
          p_author_id: string
          p_excerpt: string
          p_locale: string
          p_slug: string
          p_title: string
        }
        Returns: string
      }
      admin_create_book: {
        Args: {
          p_author_id?: string
          p_author_name: string
          p_canonical_key: string
          p_currency: string
          p_language: string
          p_locale: string
          p_market: string
          p_price_minor: number
          p_slug: string
          p_title: string
        }
        Returns: string
      }
      admin_create_bundle: {
        Args: { p_locale: string; p_slug: string; p_title: string }
        Returns: string
      }
      admin_create_coupon: {
        Args: {
          p_amount_off_minor: number
          p_book_ids: string[]
          p_bundle_ids: string[]
          p_code: string
          p_currency: string
          p_ends_at: string
          p_kind: string
          p_max_redemptions: number
          p_max_redemptions_per_profile: number
          p_note: string
          p_percent_off: number
          p_starts_at: string
        }
        Returns: string
      }
      admin_create_ebook: {
        Args: {
          p_author_name: string
          p_canonical_key: string
          p_currency: string
          p_language: string
          p_locale: string
          p_market: string
          p_price_minor: number
          p_slug: string
          p_title: string
        }
        Returns: string
      }
      admin_create_edition: {
        Args: {
          p_book_id: string
          p_edition_number: number
          p_isbn: string
          p_language_code: string
          p_publication_date: string
        }
        Returns: string
      }
      admin_create_idea: {
        Args: {
          p_locale: string
          p_question: string
          p_short_answer: string
          p_slug: string
        }
        Returns: string
      }
      admin_create_offer: {
        Args: {
          p_currency: string
          p_edition_id: string
          p_market_code: string
          p_price_minor: number
        }
        Returns: string
      }
      admin_finalize_ebook_asset: {
        Args: {
          p_asset_id: string
          p_checksum: string
          p_correlation_id: string
        }
        Returns: string
      }
      admin_get_author_image: {
        Args: { p_author_id: string }
        Returns: {
          alt_text: string
          storage_key: string
        }[]
      }
      admin_get_book_cover: {
        Args: { p_book_id: string }
        Returns: {
          alt_text: string
          storage_key: string
        }[]
      }
      admin_get_coupon: {
        Args: { p_id: string }
        Returns: {
          active: boolean
          amount_off_minor: number
          book_ids: string[]
          bundle_ids: string[]
          code: string
          created_at: string
          currency: string
          ends_at: string
          id: string
          kind: string
          max_redemptions: number
          max_redemptions_per_profile: number
          note: string
          percent_off: number
          redeemed_count: number
          reserved_count: number
          starts_at: string
        }[]
      }
      admin_list_coupons: {
        Args: Record<PropertyKey, never>
        Returns: {
          active: boolean
          amount_off_minor: number
          book_ids: string[]
          bundle_ids: string[]
          code: string
          created_at: string
          currency: string
          ends_at: string
          id: string
          kind: string
          max_redemptions: number
          max_redemptions_per_profile: number
          note: string
          percent_off: number
          redeemed_count: number
          reserved_count: number
          starts_at: string
        }[]
      }
      admin_list_edition_feedback: { Args: { p_status: string }; Returns: Json }
      admin_list_questions: { Args: { p_status: string }; Returns: Json }
      admin_list_reviews: { Args: { p_status: string }; Returns: Json }
      admin_list_shared_quotes: { Args: { p_book_id: string }; Returns: Json }
      admin_moderate_review: {
        Args: {
          p_expected_revision?: number
          p_review_id: string
          p_status: string
        }
        Returns: undefined
      }
      admin_reissue_gift: {
        Args: {
          p_claim_path: string
          p_gift_id: string
          p_reason: string
          p_recipient_email: string
          p_token_hash: string
        }
        Returns: undefined
      }
      admin_remove_shared_quote: {
        Args: { p_code: string }
        Returns: undefined
      }
      admin_reply_review: {
        Args: { p_reply: string; p_review_id: string }
        Returns: undefined
      }
      admin_resend_gift: { Args: { p_gift_id: string }; Returns: undefined }
      admin_reserve_ebook_asset: {
        Args: { p_edition_id: string }
        Returns: {
          asset_id: string
          storage_key: string
          version: number
        }[]
      }
      admin_resolve_edition_feedback: {
        Args: { p_id: string; p_note: string; p_status: string }
        Returns: undefined
      }
      admin_save_article_localization: {
        Args: {
          p_article_id: string
          p_body_blocks: Json
          p_excerpt: string
          p_locale: string
          p_slug: string
          p_title: string
        }
        Returns: string
      }
      admin_save_article_seo: {
        Args: {
          p_article_id: string
          p_locale: string
          p_seo_description: string
          p_seo_title: string
        }
        Returns: undefined
      }
      admin_save_book_localization: {
        Args: {
          p_audience: string
          p_book_id: string
          p_description: string
          p_faq: Json
          p_key_ideas: Json
          p_locale: string
          p_seo_description: string
          p_seo_title: string
          p_short_description: string
          p_slug: string
          p_subtitle: string
          p_title: string
        }
        Returns: string
      }
      admin_save_bundle_localization: {
        Args: {
          p_bundle_id: string
          p_description: string
          p_locale: string
          p_slug: string
          p_subtitle: string
          p_title: string
        }
        Returns: string
      }
      admin_save_edition: {
        Args: {
          p_contributors: Json
          p_edition_id: string
          p_edition_number: number
          p_introduction: string
          p_isbn: string
          p_language_code: string
          p_publication_date: string
        }
        Returns: undefined
      }
      admin_save_edition_provenance: {
        Args: {
          p_edition_id: string
          p_rights_note: string
          p_territory_note: string
          p_text_source_note: string
          p_translation_source: string
        }
        Returns: undefined
      }
      admin_save_entity_localization: {
        Args: {
          p_description: string
          p_entity_id: string
          p_entity_type: string
          p_locale: string
          p_name: string
          p_quote?: string
          p_slug: string
        }
        Returns: string
      }
      admin_save_idea_localization: {
        Args: {
          p_body_blocks: Json
          p_idea_id: string
          p_locale: string
          p_question: string
          p_short_answer: string
          p_slug: string
        }
        Returns: string
      }
      admin_save_idea_seo: {
        Args: {
          p_idea_id: string
          p_locale: string
          p_seo_description: string
          p_seo_title: string
        }
        Returns: undefined
      }
      admin_save_platform_settings: {
        Args: {
          p_default_content_language: string
          p_default_metadata_locale: string
          p_default_ui_locale: string
        }
        Returns: undefined
      }
      admin_search_gifts: {
        Args: { p_query: string }
        Returns: {
          attempt_count: number
          claim_locale: string
          claimed_at: string
          created_at: string
          gift_id: string
          item_count: number
          item_titles: string[]
          last_error_code: string
          order_id: string
          purchaser_email: string
          recipient_email: string
          reference_code: string
          revoked_at: string
          sent_at: string
          status: string
        }[]
      }
      admin_set_article_relations: {
        Args: {
          p_article_id: string
          p_book_ids: string[]
          p_idea_ids: string[]
          p_topic_ids: string[]
        }
        Returns: undefined
      }
      admin_set_author_image: {
        Args: {
          p_alt_text: string
          p_author_id: string
          p_height: number
          p_storage_key: string
          p_width: number
        }
        Returns: string
      }
      admin_set_book_cover: {
        Args: {
          p_alt_text: string
          p_book_id: string
          p_height: number
          p_storage_key: string
          p_width: number
        }
        Returns: string
      }
      admin_set_book_relations: {
        Args: {
          p_book_id: string
          p_series_id: string
          p_series_position: number
          p_topic_ids: string[]
        }
        Returns: undefined
      }
      admin_set_book_retail_links: {
        Args: { p_book_id: string; p_links: Json }
        Returns: undefined
      }
      admin_set_bundle_cover: {
        Args: {
          p_alt_text: string
          p_bundle_id: string
          p_height: number
          p_storage_key: string
          p_width: number
        }
        Returns: string
      }
      admin_set_bundle_members: {
        Args: { p_bundle_id: string; p_edition_ids: string[] }
        Returns: undefined
      }
      admin_set_bundle_offer: {
        Args: {
          p_active: boolean
          p_bundle_id: string
          p_currency: string
          p_market_code: string
          p_price_minor: number
        }
        Returns: string
      }
      admin_set_default_edition: {
        Args: {
          p_book_id: string
          p_edition_id: string
          p_language_code: string
        }
        Returns: undefined
      }
      admin_set_default_offer: {
        Args: { p_edition_id: string; p_offer_id: string }
        Returns: undefined
      }
      admin_set_edition_review: {
        Args: { p_edition_id: string; p_note: string; p_state: string }
        Returns: undefined
      }
      admin_set_home_hero: {
        Args: {
          p_alt_text: string
          p_desktop_key: string
          p_mobile_key: string
        }
        Returns: undefined
      }
      admin_set_idea_relations: {
        Args: {
          p_book_ids: string[]
          p_idea_id: string
          p_related_idea_ids: string[]
          p_topic_ids: string[]
        }
        Returns: undefined
      }
      admin_set_merchandising: {
        Args: { p_book_ids: string[]; p_slot_key: string }
        Returns: undefined
      }
      admin_set_related_books: {
        Args: { p_book_id: string; p_related_book_ids: string[] }
        Returns: undefined
      }
      admin_update_article: {
        Args: { p_article_id: string; p_author_id: string }
        Returns: undefined
      }
      admin_update_coupon: {
        Args: {
          p_active: boolean
          p_amount_off_minor: number
          p_book_ids: string[]
          p_bundle_ids: string[]
          p_currency: string
          p_ends_at: string
          p_id: string
          p_kind: string
          p_max_redemptions: number
          p_max_redemptions_per_profile: number
          p_note: string
          p_percent_off: number
          p_starts_at: string
        }
        Returns: undefined
      }
      apply_coupon_to_order: {
        Args: { p_code: string; p_order_id: string }
        Returns: {
          discount_minor: number
          entitlement_ids: string[]
          order_status: Database["public"]["Enums"]["order_status"]
          rejection: string
          subtotal_minor: number
          total_minor: number
        }[]
      }
      apply_payment_event: {
        Args: {
          p_amount_minor: number
          p_currency: string
          p_external_payment_id: string
          p_occurred_at: string
          p_order_id: string
          p_provider: string
          p_provider_event_id: string
          p_status: string
        }
        Returns: {
          entitlement_ids: string[]
          order_status: Database["public"]["Enums"]["order_status"]
          payment_status: Database["public"]["Enums"]["payment_status"]
        }[]
      }
      article_readiness_issues: {
        Args: { p_article_id: string }
        Returns: string[]
      }
      audit_value_summary: { Args: { p_value: Json }; Returns: Json }
      authorize_reader_session: {
        Args: { p_publication_id: string; p_session_id: string }
        Returns: {
          profile_id: string
          publication_id: string
          publication_version: number
        }[]
      }
      book_readiness_issues: { Args: { p_book_id: string }; Returns: string[] }
      book_review_json: {
        Args: { r: Database["public"]["Tables"]["book_reviews"]["Row"] }
        Returns: Json
      }
      bundle_edition_is_sellable: {
        Args: { p_edition_id: string }
        Returns: boolean
      }
      bundle_live_offer: {
        Args: { p_bundle_id: string }
        Returns: {
          currency: string
          market_code: string
          offer_id: string
          price_minor: number
        }[]
      }
      bundle_order_lines: {
        Args: { p_bundle_id: string }
        Returns: {
          book_id: string
          edition_id: string
          language_code: string
          line_position: number
          sku_id: string
          title_snapshot: string
        }[]
      }
      bundle_readiness_issues: {
        Args: { p_bundle_id: string }
        Returns: string[]
      }
      catalog_book_accepts_questions: {
        Args: { p_book_id: string }
        Returns: boolean
      }
      catalog_book_card_by_id: {
        Args: { p_book_id: string; p_locale: string }
        Returns: {
          author_name: string
          author_slug: string
          book_id: string
          cover_alt: string
          cover_path: string
          created_at: string
          currency: string
          edition_id: string
          featured: boolean
          has_active_publication: boolean
          has_sample: boolean
          is_language_fallback: boolean
          language_code: string
          list_price_minor: number
          metadata_locale: string
          offer_id: string
          price_minor: number
          sale_ends_at: string
          series_name: string
          series_position: number
          series_slug: string
          shelf_position: number
          short_description: string
          slug: string
          subtitle: string
          title: string
          topics: Json
        }[]
      }
      catalog_book_card_rows: {
        Args: { p_book_id?: string; p_locale: string }
        Returns: {
          author_name: string
          author_slug: string
          book_id: string
          cover_alt: string
          cover_path: string
          created_at: string
          currency: string
          edition_id: string
          featured: boolean
          has_active_publication: boolean
          has_sample: boolean
          is_language_fallback: boolean
          language_code: string
          list_price_minor: number
          metadata_locale: string
          offer_id: string
          price_minor: number
          sale_ends_at: string
          series_name: string
          series_position: number
          series_slug: string
          shelf_position: number
          short_description: string
          slug: string
          subtitle: string
          title: string
          topics: Json
        }[]
      }
      catalog_book_cards: {
        Args: { p_locale: string }
        Returns: {
          author_name: string
          author_slug: string
          book_id: string
          cover_alt: string
          cover_path: string
          created_at: string
          currency: string
          edition_id: string
          featured: boolean
          has_active_publication: boolean
          has_sample: boolean
          is_language_fallback: boolean
          language_code: string
          list_price_minor: number
          metadata_locale: string
          offer_id: string
          price_minor: number
          sale_ends_at: string
          series_name: string
          series_position: number
          series_slug: string
          shelf_position: number
          short_description: string
          slug: string
          subtitle: string
          title: string
          topics: Json
        }[]
      }
      catalog_book_editions: {
        Args: { p_book_id: string; p_locale: string }
        Returns: Json
      }
      catalog_book_metadata: {
        Args: { p_book_id: string; p_locale: string }
        Returns: {
          audience: string | null
          book_id: string
          description: string | null
          faq: NonNullable<Json>
          id: string
          key_ideas: NonNullable<Json>
          locale: string
          seo_description: string | null
          seo_title: string | null
          short_description: string | null
          slug: string
          subtitle: string | null
          title: string
          updated_at: string
        }[]
        SetofOptions: {
          from: "*"
          to: "book_localizations"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      catalog_book_page: {
        Args: { p_locale: string; p_slug: string }
        Returns: Json
      }
      catalog_book_reviews: {
        Args: { p_book_id: string; p_limit: number }
        Returns: Json
      }
      catalog_bundle_cover: {
        Args: { p_bundle_id: string }
        Returns: {
          alt_text: string
          storage_key: string
        }[]
      }
      catalog_bundle_live_offer: {
        Args: { p_bundle_id: string }
        Returns: {
          currency: string
          market_code: string
          offer_id: string
          price_minor: number
        }[]
      }
      catalog_edition_offer: {
        Args: { p_edition_id: string }
        Returns: {
          currency: string
          list_price_minor: number
          offer_id: string
          price_minor: number
          sale_ends_at: string
        }[]
      }
      catalog_entity_page: {
        Args: { p_kind: string; p_locale: string; p_slug: string }
        Returns: Json
      }
      catalog_has_visible_book: {
        Args: { p_entity_id: string; p_kind: string; p_locale: string }
        Returns: boolean
      }
      catalog_home_hero: { Args: Record<PropertyKey, never>; Returns: Json }
      catalog_home_topics: {
        Args: { p_locale: string }
        Returns: {
          description: string
          name: string
          slug: string
        }[]
      }
      catalog_match_score: {
        Args: { p_name: string; p_query: string }
        Returns: number
      }
      catalog_normalize: { Args: { p_value: string }; Returns: string }
      catalog_resolve_edition: {
        Args: { p_book_id: string; p_edition_id?: string; p_language: string }
        Returns: {
          edition_id: string
          is_fallback: boolean
          language_code: string
        }[]
      }
      catalog_resolved_editions: {
        Args: { p_book_id?: string; p_language: string }
        Returns: {
          book_id: string
          edition_id: string
          is_fallback: boolean
          language_code: string
        }[]
      }
      catalog_shared_quote: { Args: { p_code: string }; Returns: Json }
      claim_gift: {
        Args: { p_token: string }
        Returns: {
          already_owned: boolean
          book_id: string
          entitlement_id: string
          title: string
        }[]
      }
      claim_manual_transfer: {
        Args: { p_note: string; p_order_id: string }
        Returns: string
      }
      claim_notification_outbox: {
        Args: { p_lease_token: string; p_limit: number }
        Returns: {
          attempt_count: number
          delivery_generation: number
          entitlement_id: string
          gift_id: string
          id: string
          payload: Json
          profile_id: string
          question_id: string
          review_id: string
          template_key: string
        }[]
      }
      claim_processing_job: {
        Args: {
          p_lease_seconds: number
          p_target_id?: string
          p_worker_id: string
        }
        Returns: {
          attempt: number
          correlation_id: string
          edition_id: string
          job_id: string
          source_checksum: string
          source_storage_key: string
          target_id: string
          version: number
        }[]
      }
      complete_notification_outbox: {
        Args: {
          p_id: string
          p_lease_token: string
          p_provider_message_id: string
        }
        Returns: boolean
      }
      complete_processing_job: {
        Args: {
          p_epub_language?: string
          p_job_id: string
          p_manifest_key: string
          p_positions: Json
          p_resources: Json
          p_sample_hrefs: Json
          p_search_chunks: Json
          p_toc: Json
          p_worker_id: string
        }
        Returns: string
      }
      configure_gift: {
        Args: {
          p_claim_path: string
          p_message: string
          p_order_id: string
          p_recipient_email: string
          p_token_hash: string
        }
        Returns: undefined
      }
      confirm_manual_payment: {
        Args: {
          p_accept_mismatch?: boolean
          p_bank_reference: string
          p_note: string
          p_order_id: string
          p_received_amount_minor: number
        }
        Returns: {
          entitlement_ids: string[]
          order_status: Database["public"]["Enums"]["order_status"]
          payment_status: Database["public"]["Enums"]["payment_status"]
        }[]
      }
      consume_analytics_quota: {
        Args: {
          p_bucket_key: string
          p_limit: number
          p_window_seconds: number
        }
        Returns: boolean
      }
      coupon_attempts_exhausted: {
        Args: { p_profile_id: string }
        Returns: boolean
      }
      create_bundle_order: { Args: { p_bundle_id: string }; Returns: string }
      create_edition_order: {
        Args: {
          p_edition_id: string
          p_expected_minor?: number
          p_offer_id: string
        }
        Returns: string
      }
      create_reader_session: {
        Args: { p_publication_id: string; p_ttl_seconds: number }
        Returns: {
          expires_at: string
          id: string
          publication_version: number
        }[]
      }
      create_shared_quote: {
        Args: { p_locale: string; p_publication_id: string; p_quote: string }
        Returns: Json
      }
      currency_is_payable: { Args: { p_currency: string }; Returns: boolean }
      delete_book_review: {
        Args: { p_book_id: string; p_edition_id?: string }
        Returns: undefined
      }
      edition_is_sellable: { Args: { p_edition_id: string }; Returns: boolean }
      fail_notification_outbox: {
        Args: { p_error_code: string; p_id: string; p_lease_token: string }
        Returns: boolean
      }
      fail_processing_job: {
        Args: {
          p_error_code: string
          p_error_message: string
          p_job_id: string
          p_worker_id: string
        }
        Returns: undefined
      }
      generate_order_reference: {
        Args: Record<PropertyKey, never>
        Returns: string
      }
      get_my_book_review: {
        Args: { p_book_id: string; p_edition_id?: string }
        Returns: Json
      }
      get_my_order_gift: {
        Args: { p_order_id: string }
        Returns: {
          message: string
          recipient_email: string
          status: string
        }[]
      }
      get_my_reader_questions: {
        Args: Record<PropertyKey, never>
        Returns: Json
      }
      gift_delivery_details: {
        Args: { p_gift_id: string }
        Returns: {
          message: string
          order_id: string
          purchaser_profile_id: string
          recipient_email: string
          status: string
        }[]
      }
      grant_complimentary_entitlement: {
        Args: { p_edition_id: string; p_profile_id: string; p_reason: string }
        Returns: string
      }
      idea_readiness_issues: { Args: { p_idea_id: string }; Returns: string[] }
      is_admin: { Args: Record<PropertyKey, never>; Returns: boolean }
      is_supported_locale: { Args: { p_locale: string }; Returns: boolean }
      knowledge_article_author: {
        Args: { p_author_id: string; p_locale: string }
        Returns: Json
      }
      knowledge_article_index: {
        Args: { p_locale: string }
        Returns: {
          alternate_slugs: Json
          article_id: string
          author: Json
          excerpt: string
          published_at: string
          slug: string
          title: string
          updated_at: string
        }[]
      }
      knowledge_article_page: {
        Args: { p_locale: string; p_slug: string }
        Returns: Json
      }
      knowledge_block_ok: { Args: { p_block: Json }; Returns: boolean }
      knowledge_check_body_blocks: {
        Args: { p_body_blocks: Json; p_caller: string }
        Returns: undefined
      }
      knowledge_check_id_list: {
        Args: { p_caller: string; p_ids: string[]; p_label: string }
        Returns: undefined
      }
      knowledge_for_book: {
        Args: { p_book_id: string; p_locale: string }
        Returns: {
          excerpt: string
          kind: string
          published_at: string
          slug: string
          title: string
        }[]
      }
      knowledge_for_topic: {
        Args: { p_locale: string; p_topic_id: string }
        Returns: {
          excerpt: string
          kind: string
          published_at: string
          slug: string
          title: string
        }[]
      }
      knowledge_grapheme_estimate: { Args: { p_text: string }; Returns: number }
      knowledge_idea_index: {
        Args: { p_locale: string }
        Returns: {
          alternate_slugs: Json
          created_at: string
          idea_id: string
          question: string
          short_answer: string
          slug: string
          topics: Json
          updated_at: string
        }[]
      }
      knowledge_idea_page: {
        Args: { p_locale: string; p_slug: string }
        Returns: Json
      }
      knowledge_inline_ok: { Args: { p_content: Json }; Returns: boolean }
      knowledge_keys_ok: {
        Args: { p_allowed: string[]; p_obj: Json; p_required: string[] }
        Returns: boolean
      }
      knowledge_safe_text: {
        Args: { p_max: number; p_value: Json }
        Returns: boolean
      }
      knowledge_topic_is_published: {
        Args: { p_topic_id: string }
        Returns: boolean
      }
      knowledge_topic_refs: {
        Args: { p_entity_id: string; p_kind: string; p_locale: string }
        Returns: Json
      }
      knowledge_uuid_ok: { Args: { p_value: Json }; Returns: boolean }
      mask_email: { Args: { p_email: string }; Returns: string }
      my_shared_quotes: { Args: Record<PropertyKey, never>; Returns: Json }
      offer_effective_price_minor: {
        Args: { o: Database["public"]["Tables"]["offers"]["Row"] }
        Returns: number
      }
      order_active_entitlement_ids: {
        Args: { p_order_id: string; p_profile_id: string }
        Returns: string[]
      }
      press_grant_edition_access: {
        Args: {
          p_actor_profile_id: string
          p_edition_id: string
          p_profile_id: string
          p_reason: string
          p_source_order_id: string
          p_source_type: Database["public"]["Enums"]["entitlement_source"]
        }
        Returns: string
      }
      press_move_edition_pointer: {
        Args: { p_edition_id: string; p_publication_id: string }
        Returns: string
      }
      press_review_edition: {
        Args: { p_book_id: string; p_edition_id: string; p_profile_id: string }
        Returns: string
      }
      publication_readiness_issues: {
        Args: { p_publication_id: string }
        Returns: string[]
      }
      publish_article: { Args: { p_article_id: string }; Returns: undefined }
      publish_book: { Args: { p_book_id: string }; Returns: undefined }
      publish_bundle: { Args: { p_bundle_id: string }; Returns: undefined }
      publish_idea: { Args: { p_idea_id: string }; Returns: undefined }
      publish_publication: {
        Args: { p_publication_id: string }
        Returns: undefined
      }
      reader_annotation_request: {
        Args: {
          p_annotation_id?: string
          p_operation: string
          p_payload?: Json
          p_publication_id: string
          p_session_id: string
        }
        Returns: {
          color: string | null
          created_at: string
          id: string
          kind: string
          label: string | null
          locator_json: NonNullable<Json>
          note_text: string | null
          profile_id: string
          publication_id: string
          selected_text: string | null
          updated_at: string
        }[]
        SetofOptions: {
          from: "*"
          to: "reader_annotations"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      reader_edition_for_publication: {
        Args: { p_profile_id: string; p_publication_id: string }
        Returns: string
      }
      reader_locator_is_valid: { Args: { p_locator: Json }; Returns: boolean }
      reader_percent_decode: { Args: { p_value: string }; Returns: string }
      reader_publication_href_membership: {
        Args: { p_href: string; p_publication_id: string; p_session_id: string }
        Returns: {
          index_available: boolean
          is_member: boolean
        }[]
      }
      reader_publication_path_from_href: {
        Args: { p_href: string; p_publication_id: string }
        Returns: string
      }
      recommend_books: {
        Args: {
          p_exclude_book_ids: string[]
          p_limit: number
          p_locale: string
          p_seed_book_ids: string[]
        }
        Returns: {
          book_id: string
          pinned: boolean
          score: number
        }[]
      }
      record_coupon_failure: {
        Args: { p_profile_id: string }
        Returns: undefined
      }
      record_slug_redirect: {
        Args: { p_new_path: string; p_old_path: string }
        Returns: undefined
      }
      reject_manual_payment: {
        Args: { p_order_id: string; p_outcome: string; p_reason: string }
        Returns: {
          order_status: Database["public"]["Enums"]["order_status"]
          payment_status: Database["public"]["Enums"]["payment_status"]
        }[]
      }
      reject_publication: {
        Args: { p_publication_id: string; p_reason: string }
        Returns: undefined
      }
      remove_coupon_from_order: {
        Args: { p_order_id: string }
        Returns: {
          discount_minor: number
          subtotal_minor: number
          total_minor: number
        }[]
      }
      remove_gift: { Args: { p_order_id: string }; Returns: undefined }
      remove_shared_quote: { Args: { p_code: string }; Returns: undefined }
      replace_publication_search: {
        Args: {
          p_positions: Json
          p_publication_id: string
          p_search_chunks: Json
        }
        Returns: undefined
      }
      resolve_metadata_locale: {
        Args: { p_available: string[]; p_requested: string }
        Returns: string
      }
      resolve_public_redirect: {
        Args: { p_source_path: string }
        Returns: string
      }
      revoke_complimentary_entitlement: {
        Args: {
          p_entitlement_id: string
          p_profile_id: string
          p_reason: string
        }
        Returns: string
      }
      revoke_order_entitlement: {
        Args: { p_order_id: string; p_reason: string }
        Returns: string[]
      }
      rollback_publication: {
        Args: { p_book_id: string; p_publication_id: string }
        Returns: undefined
      }
      save_reading_progress: {
        Args: {
          p_client_sequence: number
          p_device_id: string
          p_locator: Json
          p_progression: number
          p_publication_id: string
          p_total_progression: number
        }
        Returns: {
          client_sequence: number
          device_id: string
          locator_json: Json
          progression: number
          total_progression: number
          updated_at: string
        }[]
      }
      search_catalog: {
        Args: { p_locale: string; p_query: string }
        Returns: {
          kind: string
          name: string
          score: number
          slug: string
        }[]
      }
      search_reader_publication: {
        Args: {
          p_publication_id: string
          p_query: string
          p_session_id: string
        }
        Returns: {
          chapter_title: string
          excerpt: string
          locator_json: Json
        }[]
      }
      shared_quote_graphemes: { Args: { p_text: string }; Returns: number }
      shared_quote_json: {
        Args: { q: Database["public"]["Tables"]["shared_quotes"]["Row"] }
        Returns: Json
      }
      stuck_gift_notifications: {
        Args: { p_attempt_floor: number; p_limit: number; p_now: string }
        Returns: {
          attempt_count: number
          created_at: string
          gift_id: string
          id: string
          lease_expires_at: string
          order_id: string
          sent_at: string
        }[]
      }
      submit_book_review: {
        Args: {
          p_body: string
          p_book_id: string
          p_edition_id?: string
          p_locale: string
          p_rating: number
        }
        Returns: Json
      }
      submit_edition_feedback: {
        Args: { p_locator: Json; p_message: string; p_publication_id: string }
        Returns: string
      }
      submit_reader_question: {
        Args: {
          p_body: string
          p_book_id: string
          p_idea_id: string
          p_locale: string
        }
        Returns: string
      }
      unpublish_article: { Args: { p_article_id: string }; Returns: undefined }
      unpublish_book: { Args: { p_book_id: string }; Returns: undefined }
      unpublish_bundle: { Args: { p_bundle_id: string }; Returns: undefined }
      unpublish_idea: { Args: { p_idea_id: string }; Returns: undefined }
    }
    Enums: {
      content_status: "draft" | "published" | "archived"
      ebook_asset_status:
        | "uploading"
        | "queued"
        | "processing"
        | "ready_for_preview"
        | "failed"
        | "published"
        | "superseded"
      entitlement_source:
        | "free_order"
        | "admin_grant"
        | "simulated_payment"
        | "manual_payment"
        | "sepay_payment"
      entitlement_status: "active" | "revoked"
      library_state: "unread" | "reading" | "completed"
      order_status: "draft" | "pending" | "completed" | "cancelled"
      payment_status:
        "not_required" | "pending" | "succeeded" | "failed" | "cancelled"
      processing_job_status: "queued" | "processing" | "failed" | "completed"
      publication_status:
        "ready_for_preview" | "published" | "rejected" | "superseded"
      sku_format: "ebook"
    }
    CompositeTypes: {
      bundle_order_line: {
        line_position: number | null
        book_id: string | null
        sku_id: string | null
        title_snapshot: string | null
        edition_id: string | null
        language_code: string | null
      }
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    keyof DefaultSchema["Tables"] | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    keyof DefaultSchema["Tables"] | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    keyof DefaultSchema["Enums"] | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {
      content_status: ["draft", "published", "archived"],
      ebook_asset_status: [
        "uploading",
        "queued",
        "processing",
        "ready_for_preview",
        "failed",
        "published",
        "superseded",
      ],
      entitlement_source: [
        "free_order",
        "admin_grant",
        "simulated_payment",
        "manual_payment",
        "sepay_payment",
      ],
      entitlement_status: ["active", "revoked"],
      library_state: ["unread", "reading", "completed"],
      order_status: ["draft", "pending", "completed", "cancelled"],
      payment_status: [
        "not_required",
        "pending",
        "succeeded",
        "failed",
        "cancelled",
      ],
      processing_job_status: ["queued", "processing", "failed", "completed"],
      publication_status: [
        "ready_for_preview",
        "published",
        "rejected",
        "superseded",
      ],
      sku_format: ["ebook"],
    },
  },
} as const
