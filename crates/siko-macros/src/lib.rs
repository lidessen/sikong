use proc_macro::TokenStream;
use proc_macro2::TokenStream as TokenStream2;
use quote::{format_ident, quote};
use syn::punctuated::Punctuated;
use syn::{
    Attribute, Expr, ExprLit, FnArg, Ident, ImplItem, ImplItemFn, Item, Lit, Meta, MetaNameValue,
    Pat, Signature, Token, TraitItem, TraitItemFn, Type, parse_macro_input,
};

#[proc_macro_attribute]
pub fn toolset(args: TokenStream, input: TokenStream) -> TokenStream {
    let args =
        parse_macro_input!(args with Punctuated::<MetaNameValue, Token![,]>::parse_terminated);
    let mut item = parse_macro_input!(input as Item);

    let Some(enum_name) = string_arg(&args, "enum_name").map(|name| format_ident!("{name}")) else {
        return compile_error("toolset requires enum_name = \"Name\"");
    };
    let output_ty = match string_arg(&args, "output") {
        Some(ty) => match syn::parse_str::<Type>(&ty) {
            Ok(ty) => Some(ty),
            Err(error) => return compile_error(error.to_string()),
        },
        None => None,
    };

    let (self_ty, tools) = match collect_tools(&mut item) {
        Ok(collected) => collected,
        Err(message) => return compile_error(message),
    };

    let variants = tools.iter().map(|tool| &tool.variant);
    let all_variants = tools.iter().map(|tool| {
        let variant = &tool.variant;
        quote!(Self::#variant)
    });
    let name_arms = tools.iter().map(|tool| {
        let variant = &tool.variant;
        let name = &tool.name;
        quote!(Self::#variant => #name)
    });
    let spec_arms = tools.iter().map(|tool| {
        let variant = &tool.variant;
        let name = &tool.name;
        let description = &tool.description;
        let args_ty = &tool.args_ty;
        quote! {
            Self::#variant => crate::AgentToolSpec {
                name: #name.to_string(),
                description: #description.to_string(),
                input_schema: crate::mechanism::agent_run::schema_for::<#args_ty>(),
            }
        }
    });
    let decode_arms = tools.iter().map(|tool| {
        let variant = &tool.variant;
        let method = &tool.method;
        let args_ty = &tool.args_ty;
        quote! {
            Self::#variant => serde_json::from_value::<#args_ty>(arguments)
                .map(|args| context.#method(args))
        }
    });
    let decode_impl = match (output_ty.as_ref(), self_ty.as_ref()) {
        (Some(output_ty), Some(self_ty)) => quote! {
            pub(crate) fn decode_call(
                &self,
                context: &#self_ty,
                arguments: serde_json::Value,
            ) -> serde_json::Result<#output_ty> {
                match self {
                    #(#decode_arms),*
                }
            }
        },
        (Some(_), None) => return compile_error("trait toolset cannot generate decode_call"),
        (None, _) => TokenStream2::new(),
    };

    let expanded = quote! {
        #item

        #[derive(Debug, Clone, Copy, PartialEq, Eq)]
        pub(crate) enum #enum_name {
            #(#variants),*
        }

        impl #enum_name {
            pub(crate) const ALL: &'static [Self] = &[
                #(#all_variants),*
            ];

            pub(crate) fn from_name(name: &str) -> Option<Self> {
                Self::ALL.iter().copied().find(|tool| tool.name() == name)
            }

            pub(crate) fn name(&self) -> &'static str {
                match self {
                    #(#name_arms),*
                }
            }

            pub(crate) fn spec(&self) -> crate::AgentToolSpec {
                match self {
                    #(#spec_arms),*
                }
            }

            #decode_impl
        }
    };

    expanded.into()
}

fn collect_tools(item: &mut Item) -> Result<(Option<Type>, Vec<ToolMethod>), &'static str> {
    match item {
        Item::Impl(impl_block) => {
            let mut tools = Vec::new();
            for item in impl_block.items.iter_mut() {
                let ImplItem::Fn(method) = item else {
                    continue;
                };
                if let Some(description) = take_tool_description(&mut method.attrs) {
                    tools.push(ToolMethod::from_impl_method(method, description)?);
                }
            }
            Ok((Some((*impl_block.self_ty).clone()), tools))
        }
        Item::Trait(trait_item) => {
            let mut tools = Vec::new();
            for item in trait_item.items.iter_mut() {
                let TraitItem::Fn(method) = item else {
                    continue;
                };
                if let Some(description) = take_tool_description(&mut method.attrs) {
                    tools.push(ToolMethod::from_trait_method(method, description)?);
                }
            }
            Ok((None, tools))
        }
        _ => Err("toolset can only be applied to impl blocks or traits"),
    }
}

struct ToolMethod {
    variant: Ident,
    method: Ident,
    name: String,
    description: String,
    args_ty: Type,
}

impl ToolMethod {
    fn from_impl_method(method: &ImplItemFn, description: String) -> Result<Self, &'static str> {
        Self::from_signature(&method.sig, description)
    }

    fn from_trait_method(method: &TraitItemFn, description: String) -> Result<Self, &'static str> {
        Self::from_signature(&method.sig, description)
    }

    fn from_signature(signature: &Signature, description: String) -> Result<Self, &'static str> {
        let method_ident = signature.ident.clone();
        let mut inputs = signature.inputs.iter();
        match inputs.next() {
            Some(FnArg::Receiver(_)) => {}
            _ => return Err("tool methods must take &self as the first parameter"),
        }
        let Some(FnArg::Typed(arg)) = inputs.next() else {
            return Err("tool methods must take exactly one args parameter after self");
        };
        if inputs.next().is_some() {
            return Err("tool methods must take exactly one args parameter after self");
        }
        if !matches!(&*arg.pat, Pat::Ident(_)) {
            return Err("tool args parameter must be a simple identifier");
        }

        let name = method_ident.to_string();
        let variant = snake_to_upper_camel(&name);
        Ok(Self {
            variant: format_ident!("{variant}"),
            method: method_ident,
            name,
            description,
            args_ty: (*arg.ty).clone(),
        })
    }
}

fn take_tool_description(attrs: &mut Vec<Attribute>) -> Option<String> {
    let index = attrs.iter().position(|attr| attr.path().is_ident("tool"))?;
    let attr = attrs.remove(index);
    let Meta::List(list) = attr.meta else {
        return None;
    };
    let parsed = list
        .parse_args_with(Punctuated::<MetaNameValue, Token![,]>::parse_terminated)
        .ok()?;
    string_arg(&parsed, "description")
}

fn string_arg(args: &Punctuated<MetaNameValue, Token![,]>, key: &str) -> Option<String> {
    args.iter().find_map(|arg| {
        if !arg.path.is_ident(key) {
            return None;
        }
        let Expr::Lit(ExprLit {
            lit: Lit::Str(value),
            ..
        }) = &arg.value
        else {
            return None;
        };
        Some(value.value())
    })
}

fn snake_to_upper_camel(input: &str) -> String {
    input
        .split('_')
        .filter(|part| !part.is_empty())
        .map(|part| {
            let mut chars = part.chars();
            match chars.next() {
                Some(first) => first.to_uppercase().chain(chars).collect::<String>(),
                None => String::new(),
            }
        })
        .collect()
}

fn compile_error(message: impl quote::ToTokens) -> TokenStream {
    quote!(compile_error!(#message);).into()
}
